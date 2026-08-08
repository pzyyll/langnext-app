// ABOUTME: Native worker manager: verified spawn, handshake, OCR execute, and process-tree reap.
// ABOUTME: First-party trusted workers only; process isolation is not a permission sandbox.
pub mod module_audit;
pub mod platform;
pub mod process;
pub mod protocol;

use crate::domain::native_worker::{
  NATIVE_PROTOCOL_VERSION_V1, NATIVE_WORKER_OCR_TIMEOUT_MS, NATIVE_WORKER_STDIO_MAX_BYTES, NativeFrameKind,
  NativeHandshakeRequest, NativeOcrImageRequest, NativeOcrImageResponse, NativeReadyResponse, NativeWorkerErrorCode,
};
use crate::domain::plugin_package::sha256_hex;
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode, OcrImageRequest, OcrImageResponse};
use crate::error::StorageError;
use process::{SpawnConfig, cleanup_process_tree, spawn_exact, terminate_tree_then_reap, try_wait_timeout};
use protocol::{decode_json_payload, read_frame, write_json_frame};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Host-side manager for one-shot native OCR worker execution.
#[derive(Clone, Default)]
pub struct NativeWorkerManager;

/// Capability adapter that runs OCR through a verified native worker process.
pub struct NativeOcrImageAdapter {
  package_digest: crate::domain::runtime_plugin::PackageDigest,
  content_dir: PathBuf,
  worker_exe: PathBuf,
  worker_sha256: String,
  model_root: PathBuf,
  model_set_digest: String,
  model_files: Vec<(String, String)>,
  runtime_set_digest: String,
  model_api_version: u32,
  runtime_dependencies: Vec<(String, String)>,
  manager: NativeWorkerManager,
}

impl NativeOcrImageAdapter {
  pub fn new(
    package_digest: crate::domain::runtime_plugin::PackageDigest,
    content_dir: PathBuf,
    worker_exe: PathBuf,
    worker_sha256: String,
    model_root: PathBuf,
    model_set_digest: String,
    model_files: Vec<(String, String)>,
    runtime_set_digest: String,
    model_api_version: u32,
    runtime_dependencies: Vec<(String, String)>,
  ) -> Self {
    Self {
      package_digest,
      content_dir,
      worker_exe,
      worker_sha256,
      model_root,
      model_set_digest,
      model_files,
      runtime_set_digest,
      model_api_version,
      runtime_dependencies,
      manager: NativeWorkerManager::new(),
    }
  }
}

impl crate::services::service_capabilities::OcrImageCapability for NativeOcrImageAdapter {
  fn recognize(
    &self,
    _instance_id: uuid::Uuid,
    request: OcrImageRequest,
    context: crate::domain::service_capability::ExecutionContext,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<OcrImageResponse, CapabilityError>> + Send + '_>> {
    let package_digest = self.package_digest.as_str().to_string();
    let content_dir = self.content_dir.clone();
    let worker_exe = self.worker_exe.clone();
    let worker_sha256 = self.worker_sha256.clone();
    // Content root is the lock root so dependency relative paths like `runtime/*.dll` resolve.
    let runtime_dir = content_dir.clone();
    let model_root = self.model_root.clone();
    let model_set_digest = self.model_set_digest.clone();
    let model_files = self.model_files.clone();
    let runtime_set_digest = self.runtime_set_digest.clone();
    let model_api_version = self.model_api_version;
    let runtime_dependencies = self.runtime_dependencies.clone();
    let manager = self.manager.clone();
    Box::pin(async move {
      if context.cancel.is_cancelled() {
        context.provider_attempt.mark_cancelled();
        return Err(CapabilityError::new(
          CapabilityErrorCode::Cancelled,
          "OCR request cancelled",
        ));
      }
      // Native OCR is host-local provider work for health provenance (Completed/Cancelled).
      context.provider_attempt.mark_started();
      let cancel = context.cancel.clone();
      // context.deadline is the sole total session budget (identity/spawn/handshake/OCR).
      // Never add a separate startup timeout on top of the caller budget.
      let result = tokio::task::spawn_blocking(move || {
        manager.execute(NativeWorkerExecuteRequest {
          worker_exe,
          worker_sha256,
          runtime_dir,
          model_root,
          model_files,
          package_digest,
          runtime_set_digest,
          model_set_digest,
          model_api_version,
          runtime_dependencies,
          ocr: request,
          cancel: Some(cancel),
          startup_phase_cap: None,
          session_timeout: context.deadline,
        })
      })
      .await
      .map_err(|err| CapabilityError::new(CapabilityErrorCode::Internal, err.to_string()))?;
      match result {
        Ok(response) => {
          context.provider_attempt.mark_completed();
          Ok(response)
        }
        Err(err) => {
          let mapped = map_native_storage_error(err);
          if mapped.code == CapabilityErrorCode::Cancelled {
            context.provider_attempt.mark_cancelled();
          } else {
            context.provider_attempt.mark_completed();
          }
          Err(mapped)
        }
      }
    })
  }
}

fn map_native_storage_error(err: StorageError) -> CapabilityError {
  let message = err.to_string();
  let code = if message.contains(NativeWorkerErrorCode::WorkerTimeout.as_str()) {
    CapabilityErrorCode::Timeout
  } else if message.contains(NativeWorkerErrorCode::WorkerCrashed.as_str()) {
    CapabilityErrorCode::WorkerCrashed
  } else if message.contains("cancelled") || message.contains("Cancelled") {
    CapabilityErrorCode::Cancelled
  } else if message.contains(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str()) {
    CapabilityErrorCode::ModelMissing
  } else {
    CapabilityErrorCode::PluginUnavailable
  };
  CapabilityError::new(code, message)
}

#[derive(Debug, Clone)]
pub struct NativeWorkerExecuteRequest {
  pub worker_exe: PathBuf,
  pub worker_sha256: String,
  pub runtime_dir: PathBuf,
  pub model_root: PathBuf,
  pub model_files: Vec<(String, String)>,
  pub package_digest: String,
  pub runtime_set_digest: String,
  pub model_set_digest: String,
  pub model_api_version: u32,
  /// Declared runtime DLL relative paths with pinned SHA-256 digests (from signed file index).
  pub runtime_dependencies: Vec<(String, String)>,
  pub ocr: OcrImageRequest,
  /// Optional cancel token observed during blocking execute.
  pub cancel: Option<crate::domain::cancel::CancelToken>,
  /// Optional per-phase cap for identity lock / spawn / handshake (tests may shorten).
  /// Never added to the session budget; only clamps each pre-OCR phase.
  pub startup_phase_cap: Option<Duration>,
  /// Total wall-clock budget for the entire session (identity, spawn, handshake, OCR).
  /// Production maps `ExecutionContext.deadline` here; `None` uses the OCR default budget.
  pub session_timeout: Option<Duration>,
}

impl NativeWorkerManager {
  pub fn new() -> Self {
    Self
  }

  /// Spawn the exact verified worker, complete handshake, run one OCR request, shut down and reap.
  pub fn execute(&self, request: NativeWorkerExecuteRequest) -> Result<OcrImageResponse, StorageError> {
    if request
      .cancel
      .as_ref()
      .map(|token| token.is_cancelled())
      .unwrap_or(false)
    {
      return Err(StorageError::Validation("cancelled".into()));
    }
    // One absolute session deadline: the caller budget alone (never startup + OCR).
    let session_budget = request
      .session_timeout
      .unwrap_or_else(|| Duration::from_millis(NATIVE_WORKER_OCR_TIMEOUT_MS));
    let absolute_deadline = Instant::now() + session_budget;
    let startup_phase_cap = request
      .startup_phase_cap
      .unwrap_or_else(|| Duration::from_millis(crate::domain::native_worker::NATIVE_WORKER_STARTUP_TIMEOUT_MS));

    ensure_within_deadline(absolute_deadline)?;
    ensure_not_cancelled(request.cancel.as_ref())?;
    process::assert_no_reparse_point(&request.worker_exe)
      .map_err(|code| StorageError::Validation(code.as_str().into()))?;
    process::assert_no_reparse_point(&request.runtime_dir)
      .map_err(|code| StorageError::Validation(code.as_str().into()))?;
    process::assert_no_reparse_point(&request.model_root)
      .map_err(|code| StorageError::Validation(code.as_str().into()))?;

    // Prefer a path relative to runtime_dir so package layout (`runtime/worker.exe`) locks correctly.
    let worker_rel = request
      .worker_exe
      .strip_prefix(&request.runtime_dir)
      .map(|p| p.to_string_lossy().replace('\\', "/"))
      .unwrap_or_else(|_| {
        request
          .worker_exe
          .file_name()
          .and_then(|s| s.to_str())
          .unwrap_or("worker.exe")
          .to_string()
      });
    // Identity audit phase: remaining budget capped by the startup phase minimum.
    let identity_deadline = phase_deadline(absolute_deadline, startup_phase_cap);
    ensure_within_deadline(identity_deadline)?;
    ensure_not_cancelled(request.cancel.as_ref())?;
    // Lock runtime files (no write/delete sharing) for the entire worker lifetime.
    // Deadline/cancel constrain per-chunk hashing and intermediate directory locks.
    let locked = module_audit::lock_runtime_set_until(
      &request.runtime_dir,
      &worker_rel,
      &request.worker_sha256,
      &request.runtime_dependencies,
      Some(identity_deadline),
      request.cancel.as_ref(),
    )
    .map_err(|code| map_phase_or_cancel(code, request.cancel.as_ref()))?;
    // Lock model directory/files and bind digests before spawn.
    let locked_model = module_audit::lock_model_set_until(
      &request.model_root,
      &request.model_files,
      Some(identity_deadline),
      request.cancel.as_ref(),
    )
    .map_err(|code| map_phase_or_cancel(code, request.cancel.as_ref()))?;
    ensure_within_deadline(identity_deadline)?;
    ensure_within_deadline(absolute_deadline)?;
    ensure_not_cancelled(request.cancel.as_ref())?;

    let process_nonce = Uuid::now_v7().to_string();
    // Working directory is the executable's directory so adjacent DLLs resolve without PATH.
    let work_dir = request
      .worker_exe
      .parent()
      .map(|p| p.to_path_buf())
      .unwrap_or_else(|| request.runtime_dir.clone());
    let spawn_deadline = phase_deadline(absolute_deadline, startup_phase_cap);
    ensure_within_deadline(spawn_deadline)?;
    ensure_not_cancelled(request.cancel.as_ref())?;
    // Refuse to spawn once the session budget is exhausted — no post-deadline process launch.
    if Instant::now() >= absolute_deadline {
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
      ));
    }
    #[cfg(test)]
    crate::services::execution_dispatch_probe::record(
      crate::services::execution_dispatch_probe::ExecutionDispatchKind::NativeWorker,
    );
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: request.worker_exe.clone(),
      work_dir,
      model_root: request.model_root.clone(),
      process_nonce: process_nonce.clone(),
      extra_args: vec![],
    })
    .map_err(|code| StorageError::Validation(code.as_str().into()))?;
    // Windows: child is CREATE_SUSPENDED here — no user code, no descendants yet.
    // If the budget expired during spawn, kill the process group/tree first, then reap.
    // Cleanup Result<(), String> retains terminate/kill/wait aggregate details on every path.
    if Instant::now() >= absolute_deadline || request.cancel.as_ref().map(|t| t.is_cancelled()).unwrap_or(false) {
      let cleanup = terminate_tree_then_reap(&mut spawned.child);
      let session_err = if request.cancel.as_ref().map(|t| t.is_cancelled()).unwrap_or(false) {
        StorageError::Validation("cancelled".into())
      } else {
        StorageError::Validation(NativeWorkerErrorCode::WorkerTimeout.as_str().into())
      };
      return apply_session_and_cleanup(Err(session_err), cleanup);
    }

    // Assign Job Object while still suspended so descendants cannot escape the tree.
    let job = match platform::attach_to_job(spawned.child.id()) {
      Ok(job) => job,
      Err(err) => {
        // Attach failed: fail-closed kill of the (possibly suspended) child; no descendants exist.
        let cleanup = terminate_tree_then_reap(&mut spawned.child);
        let session_err = StorageError::Validation(format!("job_attach_failed: {err}"));
        return apply_session_and_cleanup(Err(session_err), cleanup);
      }
    };
    // Resume only after successful Job assignment, using the retained primary-thread handle.
    // Resume failure still terminates the job/tree; cleanup details are never collapsed to a code alone.
    #[cfg(windows)]
    let resume_result = {
      match spawned.child.take_primary_thread() {
        Some(primary) => platform::resume_primary_thread(primary),
        None => Err("missing primary-thread handle after CREATE_SUSPENDED spawn".into()),
      }
    };
    #[cfg(not(windows))]
    let resume_result = platform::resume_primary_thread(());
    if let Err(err) = resume_result {
      let cleanup = cleanup_process_tree(&mut spawned.child, || platform::terminate_job(&job));
      drop(job);
      drop(locked);
      drop(locked_model);
      let session_err = StorageError::Validation(format!("job_resume_failed: {err}"));
      return apply_session_and_cleanup(Err(session_err), cleanup);
    }
    spawned.suspended = false;
    let job_handle = platform::job_raw_handle(&job);

    // Handshake uses remaining budget clamped by the startup phase cap; OCR uses remaining total.
    let handshake_deadline = phase_deadline(absolute_deadline, startup_phase_cap);
    let result = self.run_session(
      &mut spawned,
      &request,
      &process_nonce,
      &locked,
      job_handle,
      handshake_deadline,
      absolute_deadline,
    );
    // Always: terminate tree (best-effort) → direct kill → wait/reap. Never skip later steps.
    let cleanup = cleanup_process_tree(&mut spawned.child, || platform::terminate_job(&job));
    // Drop job after kill; locked dir/file handles release only after process reap.
    drop(job);
    drop(locked);
    drop(locked_model);
    apply_session_and_cleanup(result, cleanup)
  }

  fn run_session(
    &self,
    spawned: &mut process::SpawnedWorker,
    request: &NativeWorkerExecuteRequest,
    process_nonce: &str,
    locked: &module_audit::LockedRuntimeSet,
    job_handle: *mut std::ffi::c_void,
    handshake_deadline: Instant,
    absolute_deadline: Instant,
  ) -> Result<OcrImageResponse, StorageError> {
    let mut stdin = spawned
      .child
      .stdin
      .take()
      .ok_or_else(|| StorageError::Validation(NativeWorkerErrorCode::SpawnFailed.as_str().into()))?;
    let stdout = spawned
      .child
      .stdout
      .take()
      .ok_or_else(|| StorageError::Validation(NativeWorkerErrorCode::SpawnFailed.as_str().into()))?;
    let stderr = spawned
      .child
      .stderr
      .take()
      .ok_or_else(|| StorageError::Validation(NativeWorkerErrorCode::SpawnFailed.as_str().into()))?;
    // stdin/stdout/stderr are Option fields on NativeChild (same shape as std::process::Child).

    let flood_bytes = Arc::new(AtomicU64::new(0));
    let flood_stop = Arc::new(AtomicBool::new(false));
    let flood_hit = Arc::new(AtomicBool::new(false));
    let flood_job = job_handle as usize;
    let flood_stop_flag = flood_stop.clone();
    let flood_hit_flag = flood_hit.clone();
    let flood_counter = flood_bytes.clone();
    let stderr_drain = std::thread::spawn(move || {
      drain_stdio_bounded(stderr, &flood_counter, &flood_stop_flag, &flood_hit_flag, flood_job);
    });

    let mut reader = CountingReader {
      inner: BufReader::new(stdout),
      flood_bytes: flood_bytes.clone(),
      flood_hit: flood_hit.clone(),
      flood_stop: flood_stop.clone(),
      job_handle,
    };

    let handshake = NativeHandshakeRequest {
      protocol_version: NATIVE_PROTOCOL_VERSION_V1,
      package_digest: request.package_digest.clone(),
      runtime_set_digest: request.runtime_set_digest.clone(),
      model_set_digest: request.model_set_digest.clone(),
      process_nonce: process_nonce.to_string(),
      model_api_version: request.model_api_version,
    };
    write_json_frame(&mut stdin, NativeFrameKind::Handshake, &handshake)
      .map_err(|_| StorageError::Validation(NativeWorkerErrorCode::HandshakeFailed.as_str().into()))?;

    let ready_frame = read_frame_until(
      &mut reader,
      handshake_deadline,
      &mut spawned.child,
      job_handle,
      request.cancel.as_ref(),
      &flood_hit,
    )?;
    if ready_frame.kind != NativeFrameKind::Ready {
      flood_stop.store(true, Ordering::SeqCst);
      // Do not join the drain while the child is alive: stderr read is blocking until EOF/kill.
      drop(stderr_drain);
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::HandshakeFailed.as_str().into(),
      ));
    }
    let ready: NativeReadyResponse = decode_json_payload(&ready_frame)
      .map_err(|_| StorageError::Validation(NativeWorkerErrorCode::HandshakeFailed.as_str().into()))?;
    if ready.protocol_version != NATIVE_PROTOCOL_VERSION_V1
      || ready.package_digest != request.package_digest
      || ready.runtime_set_digest != request.runtime_set_digest
      || ready.model_set_digest != request.model_set_digest
      || ready.process_nonce != process_nonce
      || ready.model_api_version != request.model_api_version
    {
      flood_stop.store(true, Ordering::SeqCst);
      drop(stderr_drain);
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::HandshakeFailed.as_str().into(),
      ));
    }

    // Host-side module identity audit before accepting ready (Windows production path).
    // Constrained by the remaining session budget so a slow audit cannot outlive the deadline.
    #[cfg(windows)]
    {
      ensure_within_deadline(absolute_deadline)?;
      ensure_not_cancelled(request.cancel.as_ref())?;
      let modules = module_audit::enumerate_process_modules_until(
        spawned.child.id(),
        Some(absolute_deadline),
        request.cancel.as_ref(),
      )
      .map_err(|code| map_phase_or_cancel(code, request.cancel.as_ref()))?;
      module_audit::audit_loaded_modules_until(locked, &modules, Some(absolute_deadline), request.cancel.as_ref())
        .map_err(|code| map_phase_or_cancel(code, request.cancel.as_ref()))?;
    }
    #[cfg(not(windows))]
    {
      let _ = locked;
    }

    if flood_hit.load(Ordering::SeqCst) {
      flood_stop.store(true, Ordering::SeqCst);
      let _ = platform::terminate_job_handle(job_handle);
      drop(stderr_drain);
      return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
    }

    let png_bytes = decode_png_base64(&request.ocr.png_base64)?;
    let ocr_req = NativeOcrImageRequest {
      request_id: Uuid::now_v7().to_string(),
      png_bytes,
    };
    write_json_frame(&mut stdin, NativeFrameKind::OcrImageRequest, &ocr_req)
      .map_err(|_| StorageError::Validation(NativeWorkerErrorCode::ProtocolError.as_str().into()))?;

    let response_frame = read_frame_until(
      &mut reader,
      absolute_deadline,
      &mut spawned.child,
      job_handle,
      request.cancel.as_ref(),
      &flood_hit,
    )?;
    flood_stop.store(true, Ordering::SeqCst);
    // Detach drain; process kill/reap in execute() closes stderr and unblocks the reader.
    drop(stderr_drain);
    if flood_hit.load(Ordering::SeqCst) {
      let _ = platform::terminate_job_handle(job_handle);
      return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
    }
    if response_frame.kind != NativeFrameKind::OcrImageResponse {
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::ProtocolError.as_str().into(),
      ));
    }
    let response: NativeOcrImageResponse = decode_json_payload(&response_frame)
      .map_err(|_| StorageError::Validation(NativeWorkerErrorCode::ProtocolError.as_str().into()))?;
    if response.request_id != ocr_req.request_id {
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::ProtocolError.as_str().into(),
      ));
    }

    // Cooperative shutdown.
    let _ = write_json_frame(&mut stdin, NativeFrameKind::Shutdown, &serde_json::json!({}));
    let _ = stdin.flush();
    Ok(OcrImageResponse { text: response.text })
  }
}

struct CountingReader<R> {
  inner: R,
  flood_bytes: Arc<AtomicU64>,
  flood_hit: Arc<AtomicBool>,
  flood_stop: Arc<AtomicBool>,
  job_handle: *mut std::ffi::c_void,
}

// CountingReader is only used on the worker session thread.
unsafe impl<R> Send for CountingReader<R> {}

impl<R: Read> Read for CountingReader<R> {
  fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
    let n = self.inner.read(buf)?;
    if n > 0 {
      let total = self.flood_bytes.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
      if total > NATIVE_WORKER_STDIO_MAX_BYTES {
        self.flood_hit.store(true, Ordering::SeqCst);
        self.flood_stop.store(true, Ordering::SeqCst);
        let _ = platform::terminate_job_handle(self.job_handle);
        return Err(std::io::Error::new(
          std::io::ErrorKind::Other,
          NativeWorkerErrorCode::Flood.as_str(),
        ));
      }
    }
    Ok(n)
  }
}

fn drain_stdio_bounded<R: Read>(
  mut reader: R,
  flood_bytes: &AtomicU64,
  stop: &AtomicBool,
  flood_hit: &AtomicBool,
  job_handle_usize: usize,
) {
  let mut buf = [0u8; 4096];
  while !stop.load(Ordering::SeqCst) {
    match reader.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => {
        let total = flood_bytes.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
        if total > NATIVE_WORKER_STDIO_MAX_BYTES {
          flood_hit.store(true, Ordering::SeqCst);
          stop.store(true, Ordering::SeqCst);
          let _ = platform::terminate_job_handle(job_handle_usize as *mut std::ffi::c_void);
          break;
        }
      }
      Err(_) => break,
    }
  }
}

fn read_frame_until<R: std::io::Read>(
  reader: &mut R,
  deadline: Instant,
  child: &mut process::NativeChild,
  job_handle: *mut std::ffi::c_void,
  cancel: Option<&crate::domain::cancel::CancelToken>,
  flood_hit: &AtomicBool,
) -> Result<protocol::NativeFrame, StorageError> {
  if flood_hit.load(Ordering::SeqCst) {
    let _ = platform::terminate_job_handle(job_handle);
    return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
  }
  if let Ok(Some(status)) = child.try_wait() {
    if !status.success() {
      if flood_hit.load(Ordering::SeqCst) {
        return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
      }
      return Err(StorageError::Validation(
        NativeWorkerErrorCode::WorkerCrashed.as_str().into(),
      ));
    }
  }

  // Watchdog terminates the Job Object / process group at the deadline or on cancel so a blocking
  // pipe read cannot hang the host forever and child processes cannot leak.
  let cancel_flag = Arc::new(AtomicBool::new(false));
  let cancel_watch = cancel_flag.clone();
  let cancel_token = cancel.cloned();
  let job_handle_usize = job_handle as usize;
  let watchdog = std::thread::spawn(move || {
    while Instant::now() < deadline {
      if cancel_watch.load(Ordering::SeqCst) {
        return;
      }
      if cancel_token.as_ref().map(|token| token.is_cancelled()).unwrap_or(false) {
        let _ = platform::terminate_job_handle(job_handle_usize as *mut std::ffi::c_void);
        return;
      }
      std::thread::sleep(Duration::from_millis(20));
    }
    if !cancel_watch.load(Ordering::SeqCst) {
      let _ = platform::terminate_job_handle(job_handle_usize as *mut std::ffi::c_void);
    }
  });

  let result = read_frame(reader);
  cancel_flag.store(true, Ordering::SeqCst);
  let _ = watchdog.join();

  // Flood is higher priority than timeout/crash/partial frame codes.
  if flood_hit.load(Ordering::SeqCst) {
    return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
  }
  if let Err(protocol::ProtocolError::Io(ref msg)) = result {
    if msg.contains(NativeWorkerErrorCode::Flood.as_str()) || msg.contains("stdio_flood") {
      return Err(StorageError::Validation(NativeWorkerErrorCode::Flood.as_str().into()));
    }
  }

  if cancel.map(|token| token.is_cancelled()).unwrap_or(false) {
    return Err(StorageError::Validation("cancelled".into()));
  }

  match result {
    Ok(frame) => Ok(frame),
    Err(protocol::ProtocolError::Partial) | Err(protocol::ProtocolError::Io(_)) => {
      // Distinguish timeout (deadline elapsed / job kill) from spontaneous crash.
      let timed_out = Instant::now() >= deadline;
      match try_wait_timeout(child, Instant::now() + Duration::from_millis(200)) {
        Ok(Some(_)) if timed_out => Err(StorageError::Validation(
          NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
        )),
        Ok(Some(_)) => Err(StorageError::Validation(
          NativeWorkerErrorCode::WorkerCrashed.as_str().into(),
        )),
        Ok(None) if timed_out => Err(StorageError::Validation(
          NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
        )),
        Ok(None) => Err(StorageError::Validation(
          NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
        )),
        Err(code) => Err(StorageError::Validation(code.as_str().into())),
      }
    }
    Err(_) => Err(StorageError::Validation(
      NativeWorkerErrorCode::ProtocolError.as_str().into(),
    )),
  }
}

/// Earliest of absolute session deadline and now + phase_cap (remaining budget / min cap).
fn phase_deadline(absolute_deadline: Instant, phase_cap: Duration) -> Instant {
  let now = Instant::now();
  let remaining = absolute_deadline.saturating_duration_since(now);
  now + remaining.min(phase_cap)
}

fn ensure_within_deadline(deadline: Instant) -> Result<(), StorageError> {
  if Instant::now() >= deadline {
    return Err(StorageError::Validation(
      NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
    ));
  }
  Ok(())
}

fn ensure_not_cancelled(cancel: Option<&crate::domain::cancel::CancelToken>) -> Result<(), StorageError> {
  if cancel.map(|token| token.is_cancelled()).unwrap_or(false) {
    return Err(StorageError::Validation("cancelled".into()));
  }
  Ok(())
}

fn map_native_phase_error(code: NativeWorkerErrorCode) -> StorageError {
  if code == NativeWorkerErrorCode::WorkerTimeout {
    return StorageError::Validation(NativeWorkerErrorCode::WorkerTimeout.as_str().into());
  }
  StorageError::Validation(code.as_str().into())
}

/// Prefer cancel over timeout when both could explain a phase interrupt.
fn map_phase_or_cancel(
  code: NativeWorkerErrorCode,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> StorageError {
  if cancel.map(|token| token.is_cancelled()).unwrap_or(false) {
    return StorageError::Validation("cancelled".into());
  }
  map_native_phase_error(code)
}

/// Merge session outcome with process-tree cleanup. Cleanup failure is never discarded:
/// a successful session with a live unreaped tree fails closed; a failed session with a cleanup
/// failure surfaces the cleanup code (process leak is the security-critical outcome).
fn apply_session_and_cleanup<T>(
  session: Result<T, StorageError>,
  cleanup: Result<(), String>,
) -> Result<T, StorageError> {
  match (session, cleanup) {
    (Ok(value), Ok(())) => Ok(value),
    (Ok(_), Err(cleanup_err)) => Err(StorageError::Validation(format!(
      "{}: {cleanup_err}",
      NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str()
    ))),
    (Err(session_err), Ok(())) => Err(session_err),
    (Err(session_err), Err(cleanup_err)) => Err(StorageError::Validation(format!(
      "{}: {cleanup_err} (session: {session_err})",
      NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str()
    ))),
  }
}

fn decode_png_base64(png_base64: &str) -> Result<Vec<u8>, StorageError> {
  use base64::Engine;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(png_base64.trim())
    .map_err(|_| StorageError::Validation("invalid_png_base64".into()))?;
  // Bound image payload (8 MiB).
  const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
  if bytes.len() > MAX_PNG_BYTES {
    return Err(StorageError::Validation("png_too_large".into()));
  }
  Ok(bytes)
}

/// Compute a runtime-set digest over declared runtime files (path + sha256).
pub fn runtime_set_digest(files: &[(String, String)]) -> String {
  let mut material = String::new();
  let mut ordered = files.to_vec();
  ordered.sort_by(|a, b| a.0.cmp(&b.0));
  for (path, digest) in ordered {
    material.push_str(&path);
    material.push(':');
    material.push_str(&digest);
    material.push('\n');
  }
  sha256_hex(material.as_bytes())
}

/// Hash a file for runtime-set verification.
pub fn hash_file(path: &Path) -> Result<String, StorageError> {
  let bytes = std::fs::read(path).map_err(|err| StorageError::Io(err))?;
  Ok(sha256_hex(&bytes))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;
  use tempfile::TempDir;

  /// Minimal conformance worker scripted in-process via a cargo bin when available; for unit tests
  /// we embed a tiny Rust-less protocol responder using the current test process piping is hard,
  /// so we spawn `native-worker` fixture if built, otherwise a local std::process helper.
  fn build_conformance_helper(dir: &Path) -> PathBuf {
    // Compile a tiny helper with rustc if the workspace fixture is not present.
    let src = dir.join("helper.rs");
    let exe = if cfg!(windows) {
      dir.join("helper.exe")
    } else {
      dir.join("helper")
    };
    std::fs::write(
      &src,
      r#"
use std::io::{Read, Write};
fn main() {
  let mut stdin = std::io::stdin();
  let mut stdout = std::io::stdout();
  // Read one framed handshake (header 10 + payload), echo ready with same digests.
  let mut header = [0u8; 10];
  stdin.read_exact(&mut header).unwrap();
  let len = u32::from_be_bytes([header[6], header[7], header[8], header[9]]) as usize;
  let mut payload = vec![0u8; len];
  if len > 0 { stdin.read_exact(&mut payload).unwrap(); }
  let mut ready = payload.clone();
  // crude: change "protocolVersion" payload is JSON handshake; rewrite kind only by framing Ready.
  // For simplicity, re-emit the same JSON as Ready payload (tests use matching fields).
  let mut out = Vec::new();
  out.extend_from_slice(&0x4C4E_5750u32.to_be_bytes());
  out.extend_from_slice(&2u16.to_be_bytes()); // Ready
  out.extend_from_slice(&(ready.len() as u32).to_be_bytes());
  out.extend_from_slice(&ready);
  stdout.write_all(&out).unwrap();
  stdout.flush().unwrap();
  // OCR request
  let mut header2 = [0u8; 10];
  stdin.read_exact(&mut header2).unwrap();
  let len2 = u32::from_be_bytes([header2[6], header2[7], header2[8], header2[9]]) as usize;
  let mut payload2 = vec![0u8; len2];
  if len2 > 0 { stdin.read_exact(&mut payload2).unwrap(); }
  // Extract request_id crudely
  let body = String::from_utf8_lossy(&payload2);
  let rid = body.split("\"requestId\":\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("r");
  let resp = format!("{{\"requestId\":\"{rid}\",\"text\":\"hello-native\"}}");
  let mut out2 = Vec::new();
  out2.extend_from_slice(&0x4C4E_5750u32.to_be_bytes());
  out2.extend_from_slice(&4u16.to_be_bytes()); // OcrImageResponse
  out2.extend_from_slice(&(resp.len() as u32).to_be_bytes());
  out2.extend_from_slice(resp.as_bytes());
  stdout.write_all(&out2).unwrap();
  stdout.flush().unwrap();
  // Drain shutdown
  let mut header3 = [0u8; 10];
  let _ = stdin.read_exact(&mut header3);
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc")
      .arg(&src)
      .arg("-O")
      .arg("-o")
      .arg(&exe)
      .status()
      .expect("rustc available");
    assert!(status.success(), "helper compile failed");
    exe
  }

  fn fixture_model(dir: &Path) -> (PathBuf, Vec<(String, String)>) {
    let model_root = dir.join("model");
    std::fs::create_dir_all(&model_root).unwrap();
    let marker = b"model-marker-v1";
    let rel = "marker.bin".to_string();
    std::fs::write(model_root.join(&rel), marker).unwrap();
    (model_root, vec![(rel, sha256_hex(marker))])
  }

  fn worker_sha(path: &Path) -> String {
    sha256_hex(&std::fs::read(path).unwrap())
  }

  #[test]
  fn native_worker_handshake_reaps_process() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let exe = build_conformance_helper(dir.path());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let response = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: None,
        session_timeout: None,
      })
      .expect("native worker execute");
    assert_eq!(response.text, "hello-native");
  }

  #[test]
  fn execution_dispatch_probe_records_native_worker() {
    use crate::services::execution_dispatch_probe::scope;
    let _probe = scope();
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let exe = build_conformance_helper(dir.path());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let response = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: None,
        session_timeout: None,
      })
      .expect("native worker execute");
    assert_eq!(response.text, "hello-native");
    let counts = _probe.snapshot();
    // The probe counts every thread while armed, so parallel tests may add dispatches;
    // assert the expected category fired rather than an exact total.
    assert!(
      counts.native_worker >= 1,
      "at least one real native worker spawn must be observed"
    );
  }

  #[test]
  fn native_worker_timeout_kills_process_tree() {
    // Hang worker: never writes ready. Manager must time out and leave no live process.
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let src = dir.path().join("hang.rs");
    let exe = dir.path().join(if cfg!(windows) { "hang.exe" } else { "hang" });
    std::fs::write(
      &src,
      "fn main(){ loop { std::thread::sleep(std::time::Duration::from_secs(60)); } }",
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success());
    let worker_sha256 = worker_sha(&exe);

    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe.clone(),
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_millis(300)),
        session_timeout: Some(Duration::from_millis(300)),
      })
      .expect_err("hang worker must time out");
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("WorkerTimeout") || msg.contains("timeout"),
      "expected timeout error, got {err:?}"
    );

    // No live process should remain for the hang executable name.
    #[cfg(windows)]
    {
      let output = Command::new("tasklist")
        .args([
          "/FI",
          &format!("IMAGENAME eq {}", exe.file_name().unwrap().to_string_lossy()),
        ])
        .output()
        .expect("tasklist");
      let stdout = String::from_utf8_lossy(&output.stdout);
      assert!(
        !stdout.to_ascii_lowercase().contains("hang.exe"),
        "hang worker process leaked: {stdout}"
      );
    }
  }

  /// Caller deadline is the sole total budget: must not silently add the 15s startup default.
  #[test]
  fn native_worker_caller_deadline_is_total_budget_without_extra_startup() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let src = dir.path().join("hang_budget.rs");
    let exe = dir.path().join(if cfg!(windows) {
      "hang_budget.exe"
    } else {
      "hang_budget"
    });
    std::fs::write(
      &src,
      "fn main(){ loop { std::thread::sleep(std::time::Duration::from_secs(60)); } }",
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let started = Instant::now();
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        // No phase override: production path. Session budget alone must bound the hang.
        startup_phase_cap: None,
        session_timeout: Some(Duration::from_millis(400)),
      })
      .expect_err("hang must time out within caller budget");
    let elapsed = started.elapsed();
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("timeout"),
      "expected timeout, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "must not add NATIVE_WORKER_STARTUP_TIMEOUT_MS on top of caller deadline; elapsed={elapsed:?}"
    );
    assert!(
      elapsed >= Duration::from_millis(250),
      "should roughly consume the caller budget; elapsed={elapsed:?}"
    );
  }

  /// Expired session budget must fail during identity lock without spawning a worker.
  #[test]
  fn native_worker_expired_budget_fails_identity_before_spawn() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let exe = build_conformance_helper(dir.path());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe.clone(),
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_millis(1)),
        // Zero budget: identity phase must observe the deadline and never spawn.
        session_timeout: Some(Duration::ZERO),
      })
      .expect_err("zero budget must fail");
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("timeout"),
      "expected timeout before spawn, got {err:?}"
    );
  }

  /// Slow identity hashing of a large worker must be cut off by the session deadline.
  #[test]
  fn native_worker_slow_identity_hash_respects_session_deadline() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    // Multi-megabyte payload forces multi-chunk hashing under a tight deadline.
    let big = vec![0x5Au8; 8 * 1024 * 1024];
    let exe = dir
      .path()
      .join(if cfg!(windows) { "big_worker.exe" } else { "big_worker" });
    std::fs::write(&exe, &big).unwrap();
    let worker_sha256 = sha256_hex(&big);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let started = Instant::now();
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_millis(1)),
        session_timeout: Some(Duration::from_millis(1)),
      })
      .expect_err("slow identity must time out");
    let elapsed = started.elapsed();
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("timeout"),
      "expected identity timeout, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "identity deadline must bound hashing; elapsed={elapsed:?}"
    );
  }

  /// Handshake hang is bounded by the remaining session budget (startup phase).
  #[test]
  fn native_worker_handshake_hang_respects_session_deadline() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let src = dir.path().join("hang_handshake.rs");
    let exe = dir.path().join(if cfg!(windows) {
      "hang_handshake.exe"
    } else {
      "hang_handshake"
    });
    std::fs::write(
      &src,
      "fn main(){ loop { std::thread::sleep(std::time::Duration::from_secs(60)); } }",
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let started = Instant::now();
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_millis(250)),
        session_timeout: Some(Duration::from_millis(250)),
      })
      .expect_err("handshake hang must time out");
    let elapsed = started.elapsed();
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("timeout"),
      "expected handshake timeout, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "handshake must honor session deadline; elapsed={elapsed:?}"
    );
  }

  /// OCR hang after a successful handshake is still bounded by the absolute session deadline.
  #[test]
  fn native_worker_ocr_hang_respects_session_deadline() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let src = dir.path().join("hang_ocr.rs");
    let exe = dir.path().join(if cfg!(windows) { "hang_ocr.exe" } else { "hang_ocr" });
    // Completes handshake, then hangs forever on OCR.
    std::fs::write(
      &src,
      r#"
use std::io::{Read, Write};
fn main() {
  let mut stdin = std::io::stdin();
  let mut stdout = std::io::stdout();
  let mut header = [0u8; 10];
  stdin.read_exact(&mut header).unwrap();
  let len = u32::from_be_bytes([header[6], header[7], header[8], header[9]]) as usize;
  let mut payload = vec![0u8; len];
  if len > 0 { stdin.read_exact(&mut payload).unwrap(); }
  let mut out = Vec::new();
  out.extend_from_slice(&0x4C4E_5750u32.to_be_bytes());
  out.extend_from_slice(&2u16.to_be_bytes());
  out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
  out.extend_from_slice(&payload);
  stdout.write_all(&out).unwrap();
  stdout.flush().unwrap();
  loop { std::thread::sleep(std::time::Duration::from_secs(60)); }
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let started = Instant::now();
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_secs(5)),
        session_timeout: Some(Duration::from_millis(500)),
      })
      .expect_err("OCR hang must time out");
    let elapsed = started.elapsed();
    let msg = err.to_string();
    assert!(
      msg.contains("worker_timeout") || msg.contains("timeout"),
      "expected OCR timeout, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(4),
      "OCR must honor absolute session deadline; elapsed={elapsed:?}"
    );
  }

  #[test]
  fn apply_session_and_cleanup_propagates_terminate_failure_on_success() {
    let session: Result<&'static str, StorageError> = Ok("ok");
    let cleanup = Err("terminate: TerminateJobObject failed: 6".to_string());
    let err = apply_session_and_cleanup(session, cleanup).expect_err("cleanup must surface");
    let msg = err.to_string();
    assert!(
      msg.contains(NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str()),
      "stable cleanup code required, got {msg}"
    );
    assert!(
      msg.contains("terminate:"),
      "aggregate terminate detail required, got {msg}"
    );
    assert!(msg.contains("TerminateJobObject"), "got {msg}");
  }

  #[test]
  fn apply_session_and_cleanup_prefers_cleanup_failure_over_session_error() {
    let session: Result<(), StorageError> = Err(StorageError::Validation(
      NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
    ));
    let cleanup = Err("terminate: process-group kill failed".to_string());
    let err = apply_session_and_cleanup(session, cleanup).expect_err("both failed");
    let msg = err.to_string();
    assert!(
      msg.contains(NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str()),
      "cleanup failure must not be discarded under session error, got {msg}"
    );
    assert!(msg.contains("terminate:"), "got {msg}");
    assert!(msg.contains("process-group") || msg.contains("failed"), "got {msg}");
    assert!(msg.contains("worker_timeout") || msg.contains("session"), "got {msg}");
  }

  /// Deadline/attach/session paths must retain multi-step terminate/kill/wait details, not a lone code.
  #[test]
  fn apply_session_and_cleanup_preserves_terminate_kill_wait_multi_failure_details() {
    let session: Result<(), StorageError> = Err(StorageError::Validation(
      NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
    ));
    let cleanup = Err("terminate: TerminateJobObject failed: 6; kill: access denied; wait: wait broken".to_string());
    let err = apply_session_and_cleanup(session, cleanup).expect_err("both failed");
    let msg = err.to_string();
    assert!(
      msg.contains(NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str()),
      "stable code required, got {msg}"
    );
    assert!(msg.contains("terminate:"), "got {msg}");
    assert!(msg.contains("kill:"), "got {msg}");
    assert!(msg.contains("wait:"), "got {msg}");
    assert!(
      msg.contains("worker_timeout") || msg.contains("session"),
      "session detail, got {msg}"
    );
    // Must not collapse to only the stable code (no unique step details).
    assert!(msg.len() > NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str().len() + 8);
  }

  #[test]
  fn apply_session_and_cleanup_preserves_session_error_when_cleanup_ok() {
    let session: Result<(), StorageError> = Err(StorageError::Validation(
      NativeWorkerErrorCode::WorkerTimeout.as_str().into(),
    ));
    let err = apply_session_and_cleanup(session, Ok(())).expect_err("session");
    assert!(err.to_string().contains("worker_timeout"));
  }

  #[test]
  fn terminate_job_handle_invalid_propagates_stable_error() {
    // Failure injection: an invalid job handle must not report tree-kill success.
    #[cfg(windows)]
    {
      // INVALID_HANDLE_VALUE (-1) — null is intentionally a no-op Ok for empty watchdogs.
      let invalid = (-1isize) as *mut std::ffi::c_void;
      let result = platform::terminate_job_handle(invalid);
      assert!(result.is_err(), "invalid job handle must fail TerminateJobObject");
      let msg = result.unwrap_err();
      assert!(
        msg.contains("TerminateJobObject") || msg.contains("failed"),
        "got {msg}"
      );
      let merged = apply_session_and_cleanup(Ok(()), Err(msg)).expect_err("merged");
      assert!(
        merged
          .to_string()
          .contains(NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str())
      );
    }
    #[cfg(not(windows))]
    {
      // Parent-only fallback already returns Err from kill_process_tree; merge must surface it.
      let merged = apply_session_and_cleanup(
        Ok(()),
        Err("process-group kill failed for pid 1; parent-only kill is not tree success".into()),
      )
      .expect_err("merged");
      assert!(
        merged
          .to_string()
          .contains(NativeWorkerErrorCode::ProcessTreeCleanupFailed.as_str())
      );
    }
  }

  #[test]
  fn native_worker_stdio_flood_returns_flood_code_not_timeout() {
    let dir = TempDir::new().unwrap();
    let (model_root, model_files) = fixture_model(dir.path());
    let src = dir.path().join("flood.rs");
    let exe = dir.path().join(if cfg!(windows) { "flood.exe" } else { "flood" });
    std::fs::write(
      &src,
      r#"
use std::io::Write;
fn main() {
  let mut out = std::io::stdout();
  // Valid frame header with a 2 MiB payload so the host CountingReader hits flood mid-body.
  out.write_all(&0x4C4E_5750u32.to_be_bytes()).unwrap();
  out.write_all(&2u16.to_be_bytes()).unwrap(); // Ready
  let len = 2u32 * 1024 * 1024;
  out.write_all(&len.to_be_bytes()).unwrap();
  let chunk = vec![b'F'; 64 * 1024];
  for _ in 0..32 {
    let _ = out.write_all(&chunk);
  }
  let _ = out.flush();
  loop { std::thread::sleep(std::time::Duration::from_secs(30)); }
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success());
    let worker_sha256 = worker_sha(&exe);
    let manager = NativeWorkerManager::new();
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
    let err = manager
      .execute(NativeWorkerExecuteRequest {
        worker_exe: exe,
        worker_sha256,
        runtime_dir: dir.path().to_path_buf(),
        model_root,
        model_files,
        package_digest: "a".repeat(64),
        runtime_set_digest: "b".repeat(64),
        model_set_digest: "c".repeat(64),
        model_api_version: 1,
        runtime_dependencies: vec![],
        ocr: OcrImageRequest {
          png_base64: png,
          preferences: crate::domain::service_capability::OcrImagePreferences {
            operation: crate::domain::service_capability::OcrImageOperation::DocumentTextDetection,
            language_hints: vec![],
          },
        },
        cancel: None,
        startup_phase_cap: Some(Duration::from_secs(5)),
        session_timeout: Some(Duration::from_secs(5)),
      })
      .expect_err("flood must fail");
    let msg = err.to_string();
    assert!(
      msg.contains("stdio_flood") || msg.contains("Flood"),
      "expected flood stable code, got {err:?}"
    );
    assert!(
      !msg.contains("worker_timeout"),
      "flood must not be reported as timeout: {err:?}"
    );
  }
}
