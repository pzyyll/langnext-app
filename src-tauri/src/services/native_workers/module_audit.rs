// ABOUTME: Host-side module identity audit for native worker processes.
// ABOUTME: Non-system modules must match locked signed runtime files; system modules stay under System32/API-set.
use crate::domain::native_worker::{NativeWorkerErrorCode, is_windows_system_or_api_set_module};
use crate::domain::plugin_package::encode_lowercase_hex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Stable volume + file identity captured from an open handle (fail-closed comparison key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileIdentity {
  pub volume_serial: u64,
  pub file_index_high: u64,
  pub file_index_low: u64,
}

/// One locked runtime file opened without write/delete sharing for the worker lifetime.
#[derive(Debug)]
pub struct LockedRuntimeFile {
  pub relative_path: String,
  pub absolute_path: PathBuf,
  pub sha256: String,
  /// Basename used for module matching (lowercase).
  pub basename: String,
  pub identity: FileIdentity,
  _lock: std::fs::File,
}

/// Directory handle retained without write/delete sharing for the worker lifetime.
#[derive(Debug)]
pub struct LockedDirectory {
  pub absolute_path: PathBuf,
  pub identity: FileIdentity,
  _lock: std::fs::File,
}

/// Signed runtime set locked for one worker session.
#[derive(Debug)]
pub struct LockedRuntimeSet {
  pub runtime_dir: LockedDirectory,
  pub worker_exe: LockedRuntimeFile,
  pub dependencies: Vec<LockedRuntimeFile>,
  /// Intermediate directories held open (no-follow) so they cannot be swapped for junctions.
  _intermediate_dirs: Vec<LockedDirectory>,
  by_basename: HashMap<String, usize>,
}

/// Model root + declared files locked for one worker session.
#[derive(Debug)]
pub struct LockedModelSet {
  pub model_root: LockedDirectory,
  pub files: Vec<LockedRuntimeFile>,
  /// Intermediate directories held open (no-follow) under the model root.
  _intermediate_dirs: Vec<LockedDirectory>,
}

/// Open runtime files without following reparse points and without write/delete sharing.
/// `worker_expected_sha` binds the executable identity to the signed package index.
pub fn lock_runtime_set(
  runtime_dir: &Path,
  worker_rel: &str,
  worker_expected_sha: &str,
  dependency_rels: &[(String, String)],
) -> Result<LockedRuntimeSet, NativeWorkerErrorCode> {
  lock_runtime_set_until(
    runtime_dir,
    worker_rel,
    worker_expected_sha,
    dependency_rels,
    None,
    None,
  )
}

/// Same as [`lock_runtime_set`] with an absolute wall-clock deadline and optional cancel flag.
pub fn lock_runtime_set_until(
  runtime_dir: &Path,
  worker_rel: &str,
  worker_expected_sha: &str,
  dependency_rels: &[(String, String)],
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<LockedRuntimeSet, NativeWorkerErrorCode> {
  ensure_deadline_and_cancel(deadline, cancel)?;
  let runtime_dir_lock = lock_directory(runtime_dir)?;
  let mut intermediate_dirs = Vec::new();

  let worker_rel_norm = normalize_relative(worker_rel)?;
  let (worker, worker_intermediates) = lock_relative_file(runtime_dir, &worker_rel_norm, deadline, cancel)?;
  intermediate_dirs.extend(worker_intermediates);
  if worker.sha256 != worker_expected_sha {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  ensure_deadline_and_cancel(deadline, cancel)?;

  let mut dependencies = Vec::with_capacity(dependency_rels.len());
  let mut by_basename = HashMap::new();
  for (rel, expected_sha) in dependency_rels {
    ensure_deadline_and_cancel(deadline, cancel)?;
    let rel_norm = normalize_relative(rel)?;
    let (locked, more_dirs) = lock_relative_file(runtime_dir, &rel_norm, deadline, cancel)?;
    if locked.sha256 != *expected_sha {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    intermediate_dirs.extend(more_dirs);
    let idx = dependencies.len();
    by_basename.insert(locked.basename.clone(), idx);
    dependencies.push(locked);
  }
  Ok(LockedRuntimeSet {
    runtime_dir: runtime_dir_lock,
    worker_exe: worker,
    dependencies,
    _intermediate_dirs: intermediate_dirs,
    by_basename,
  })
}

/// Lock and hash the verified model root + declared expanded files for the worker lifetime.
pub fn lock_model_set(
  model_root: &Path,
  model_files: &[(String, String)],
) -> Result<LockedModelSet, NativeWorkerErrorCode> {
  lock_model_set_until(model_root, model_files, None, None)
}

/// Same as [`lock_model_set`] with an absolute wall-clock deadline and optional cancel flag.
pub fn lock_model_set_until(
  model_root: &Path,
  model_files: &[(String, String)],
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<LockedModelSet, NativeWorkerErrorCode> {
  ensure_deadline_and_cancel(deadline, cancel)?;
  let model_root_lock = lock_directory(model_root)?;
  if model_files.is_empty() {
    return Err(NativeWorkerErrorCode::ModelDigestMismatch);
  }
  let mut locked_files = Vec::with_capacity(model_files.len());
  let mut intermediate_dirs = Vec::new();
  for (rel, expected_sha) in model_files {
    ensure_deadline_and_cancel(deadline, cancel)?;
    let rel_norm = normalize_relative(rel)?;
    let (locked, more_dirs) = lock_relative_file(model_root, &rel_norm, deadline, cancel)?;
    if locked.sha256 != *expected_sha {
      return Err(NativeWorkerErrorCode::ModelDigestMismatch);
    }
    intermediate_dirs.extend(more_dirs);
    locked_files.push(locked);
  }
  Ok(LockedModelSet {
    model_root: model_root_lock,
    files: locked_files,
    _intermediate_dirs: intermediate_dirs,
  })
}

fn ensure_deadline_and_cancel(
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<(), NativeWorkerErrorCode> {
  // Cancel is checked first; callers map this to "cancelled" when the token is set.
  // WorkerTimeout is reused as the interrupt signal — execute() prefers cancel over timeout.
  if cancel.map(|token| token.is_cancelled()).unwrap_or(false) {
    return Err(NativeWorkerErrorCode::WorkerTimeout);
  }
  if let Some(deadline) = deadline {
    if Instant::now() >= deadline {
      return Err(NativeWorkerErrorCode::WorkerTimeout);
    }
  }
  Ok(())
}

fn normalize_relative(relative: &str) -> Result<String, NativeWorkerErrorCode> {
  let normalized = relative.replace('\\', "/");
  let trimmed = normalized.trim_start_matches('/');
  if trimmed.is_empty() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  for component in trimmed.split('/') {
    if component.is_empty() || component == "." || component == ".." || component.contains('\0') {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
  }
  Ok(trimmed.to_string())
}

/// Resolve `relative` under an already-trusted root, locking every intermediate directory with
/// no-follow opens so a mid-path junction/reparse cannot redirect the final open.
fn lock_relative_file(
  root: &Path,
  relative: &str,
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<(LockedRuntimeFile, Vec<LockedDirectory>), NativeWorkerErrorCode> {
  let components: Vec<&str> = relative.split('/').filter(|c| !c.is_empty()).collect();
  if components.is_empty() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  let mut current = root.to_path_buf();
  let mut intermediate_dirs = Vec::new();
  for (index, component) in components.iter().enumerate() {
    ensure_deadline_and_cancel(deadline, cancel)?;
    // Reject path components that could escape or confuse no-follow resolution.
    if component.as_bytes().contains(&0) || matches!(*component, "." | ".." | "") {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    current = current.join(component);
    let is_last = index + 1 == components.len();
    if is_last {
      let mut file = open_read_no_write_delete(&current)?;
      let sha256 = hash_open_handle_until(&mut file, deadline, cancel)?;
      let identity = file_identity_from_handle(&file)?;
      let basename = component.to_ascii_lowercase();
      return Ok((
        LockedRuntimeFile {
          relative_path: relative.to_string(),
          absolute_path: current,
          sha256,
          basename,
          identity,
          _lock: file,
        },
        intermediate_dirs,
      ));
    }
    // Intermediate: open no-follow and retain the directory handle for the lock lifetime.
    let dir = lock_directory(&current)?;
    intermediate_dirs.push(dir);
  }
  Err(NativeWorkerErrorCode::SpawnFailed)
}

fn lock_directory(path: &Path) -> Result<LockedDirectory, NativeWorkerErrorCode> {
  // Single open without following reparse points; attributes + identity come from that handle.
  let file = open_directory_no_write_delete(path)?;
  let identity = file_identity_from_handle(&file)?;
  Ok(LockedDirectory {
    absolute_path: path.to_path_buf(),
    identity,
    _lock: file,
  })
}

/// Identity-hash chunk size. Named so deadline/cancel polls stay independent of magic numbers.
const HASH_CHUNK_BYTES: usize = 64 * 1024;
/// Poll interval while waiting for pending I/O or a helper process to finish or be cancelled.
const HASH_HELPER_POLL_INTERVAL: Duration = Duration::from_millis(20);
/// Calling-thread budget after CancelIoEx / helper kill before ownership transfer or timeout.
const HASH_CANCEL_JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Background reaper budget after ownership transfer on the Windows overlapped cancel path.
/// Unix helper reapers must not use this to abandon waitpid — they hold ownership until reap.
const HASH_CANCEL_REAPER_TIMEOUT: Duration = Duration::from_secs(30);
/// High FD base for posix_spawn intermediate dups (above fixed helper FDs 3/4/5).
#[cfg(unix)]
const HASH_HELPER_SAFE_FD_BASE: i32 = 64;

fn hash_open_handle_until(
  file: &mut std::fs::File,
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<String, NativeWorkerErrorCode> {
  // Architecture (fail-closed; FILE_TYPE_DISK / is_file are NOT locality proofs):
  // 1. open_read_no_write_delete rejects pipes/devices and non-allowlisted volumes/mounts.
  // 2. Hashing is continuously cancellable without a permanent join hang:
  //    - Windows: overlapped ReadFile + CancelIoEx on the caller's I/O (no helper thread).
  //    - Unix: independent helper process + kill/wait (no process-global signal handlers).
  ensure_deadline_and_cancel(deadline, cancel)?;
  #[cfg(windows)]
  {
    // Windows files are opened with FILE_FLAG_OVERLAPPED; always use the overlapped path.
    return hash_open_handle_overlapped(file, deadline, cancel);
  }
  #[cfg(unix)]
  {
    if deadline.is_none() && cancel.is_none() {
      return hash_open_handle_sync(file);
    }
    return hash_open_handle_helper_process(file, deadline, cancel);
  }
  #[cfg(not(any(windows, unix)))]
  {
    let _ = (file, deadline, cancel);
    Err(NativeWorkerErrorCode::SpawnFailed)
  }
}

fn hash_open_handle_sync(file: &mut std::fs::File) -> Result<String, NativeWorkerErrorCode> {
  let mut hasher = Sha256::new();
  let mut buffer = [0u8; HASH_CHUNK_BYTES];
  loop {
    let n = file
      .read(&mut buffer)
      .map_err(|_| NativeWorkerErrorCode::RuntimeDigestMismatch)?;
    if n == 0 {
      break;
    }
    hasher.update(&buffer[..n]);
  }
  Ok(encode_lowercase_hex(&hasher.finalize()))
}

/// Windows OVERLAPPED layout used by identity-hash ReadFile.
#[cfg(windows)]
#[repr(C)]
struct HashOverlapped {
  internal: usize,
  internal_high: usize,
  offset: u32,
  offset_high: u32,
  event: *mut std::ffi::c_void,
}

/// How a cancelled overlapped read was made safe to free (test-observable).
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelledIoSettlement {
  /// Non-blocking GetOverlappedResult observed completion; resources freed on the calling thread.
  CompletionConfirmed,
  /// Still pending after the calling-thread deadline; state owned by a reaper until completion.
  OwnershipTransferredToReaper,
}

#[cfg(all(windows, test))]
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
#[cfg(all(windows, test))]
static CANCEL_IO_COMPLETION_CONFIRMED: AtomicU64 = AtomicU64::new(0);
#[cfg(all(windows, test))]
static CANCEL_IO_REAPER_TRANSFERRED: AtomicU64 = AtomicU64::new(0);
#[cfg(all(windows, test))]
static CANCEL_IO_CANCEL_IOEX_CHECKED: AtomicU64 = AtomicU64::new(0);
#[cfg(all(windows, test))]
static CANCEL_IO_REAPER_OWNED_HANDLE: AtomicU64 = AtomicU64::new(0);

/// Pending overlapped state transferred to a reaper thread as pure integers + raw boxes.
/// `owned_file` is the same owned handle that initiated ReadFile (never a post-hoc DuplicateHandle).
/// SAFETY: exclusive ownership of OVERLAPPED/buffer/event/owned_file; never shared across threads.
#[cfg(windows)]
struct SendableOverlappedState {
  /// Owned file handle that started the overlapped I/O; reaper uses this exact handle.
  owned_file: usize,
  overlapped: usize,
  buffer: usize,
  event: usize,
}

/// Free OVERLAPPED/buffer/event (and optional owned file handle) only after completion is observed.
/// Never free while ERROR_IO_INCOMPLETE.
#[cfg(windows)]
fn release_overlapped_resources(
  overlapped: Box<HashOverlapped>,
  buffer: Box<[u8; HASH_CHUNK_BYTES]>,
  event: *mut std::ffi::c_void,
  owned_file: *mut std::ffi::c_void,
) {
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
  }
  if !event.is_null() {
    unsafe {
      let _ = CloseHandle(event);
    }
  }
  if !owned_file.is_null() {
    unsafe {
      let _ = CloseHandle(owned_file);
    }
  }
  // Explicit drops keep ownership order obvious for reviewers.
  drop(overlapped);
  drop(buffer);
}

/// Create an owned handle for overlapped I/O **before** ReadFile.
/// The returned handle is the only handle used for ReadFile / GetOverlappedResult / CancelIoEx /
/// reaper poll — never DuplicateHandle after I/O is already pending.
#[cfg(windows)]
fn take_owned_io_handle(file: *mut std::ffi::c_void) -> Option<*mut std::ffi::c_void> {
  const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn DuplicateHandle(
      source_process: *mut std::ffi::c_void,
      source: *mut std::ffi::c_void,
      target_process: *mut std::ffi::c_void,
      target: *mut *mut std::ffi::c_void,
      desired_access: u32,
      inherit: i32,
      options: u32,
    ) -> i32;
  }

  if file.is_null() {
    return None;
  }
  let process = unsafe { GetCurrentProcess() };
  let mut owned: *mut std::ffi::c_void = std::ptr::null_mut();
  let ok = unsafe { DuplicateHandle(process, file, process, &mut owned, 0, 0, DUPLICATE_SAME_ACCESS) };
  if ok == 0 || owned.is_null() { None } else { Some(owned) }
}

/// Poll for overlapped completion without a permanent blocking wait.
/// Returns true when the I/O is no longer pending (success or terminal error).
#[cfg(windows)]
fn poll_overlapped_complete(
  file: *mut std::ffi::c_void,
  overlapped: &mut HashOverlapped,
  event: *mut std::ffi::c_void,
  deadline: Instant,
) -> bool {
  const ERROR_IO_INCOMPLETE: u32 = 996;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetOverlappedResult(
      file: *mut std::ffi::c_void,
      overlapped: *mut HashOverlapped,
      number_of_bytes_transferred: *mut u32,
      wait: i32,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn GetLastError() -> u32;
  }

  loop {
    let mut transferred = 0u32;
    // Never pass bWait=TRUE: CancelIoEx may have failed and the I/O may never complete.
    let got = unsafe { GetOverlappedResult(file, overlapped, &mut transferred, 0) };
    if got != 0 {
      return true;
    }
    if unsafe { GetLastError() } != ERROR_IO_INCOMPLETE {
      // Terminal completion error (e.g. ERROR_OPERATION_ABORTED) — safe to free.
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    let wait_ms = remaining
      .min(HASH_HELPER_POLL_INTERVAL)
      .as_millis()
      .min(u32::MAX as u128) as u32;
    let _ = unsafe { WaitForSingleObject(event, wait_ms.max(1)) };
  }
}

/// After a cancel decision: check CancelIoEx, settle pending I/O against the caller's absolute
/// deadline, and if still pending transfer the **same** owned I/O handle to a reaper.
/// `owned_file` must be the handle that initiated ReadFile (created before I/O). Never
/// DuplicateHandle after the fact. Never free while pending (UAF), never invent a fresh request
/// budget after the absolute deadline, and never block the caller on GetOverlappedResult(TRUE).
///
/// On return, ownership of `owned_file` has been consumed (closed on completion, or held by the
/// reaper). The caller must not CloseHandle it again.
///
/// `absolute_deadline` is the caller's request budget. Calling-thread settlement uses only the
/// remaining time on that deadline (already-expired → immediate reaper transfer). The reaper's
/// cleanup budget is separate and best-effort; it never reports success to the caller.
#[cfg(windows)]
fn cancel_and_release_overlapped(
  owned_file: *mut std::ffi::c_void,
  mut overlapped: Box<HashOverlapped>,
  buffer: Box<[u8; HASH_CHUNK_BYTES]>,
  event: *mut std::ffi::c_void,
  absolute_deadline: Option<Instant>,
) -> CancelledIoSettlement {
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CancelIoEx(file: *mut std::ffi::c_void, overlapped: *mut HashOverlapped) -> i32;
    fn GetLastError() -> u32;
  }

  // CancelIoEx result must be observed: failure means the I/O may never complete via cancel.
  // Always cancel/poll with the same owned handle that initiated ReadFile.
  let cancel_ok = unsafe { CancelIoEx(owned_file, overlapped.as_mut()) };
  let _cancel_err = if cancel_ok == 0 {
    Some(unsafe { GetLastError() })
  } else {
    None
  };
  #[cfg(test)]
  CANCEL_IO_CANCEL_IOEX_CHECKED.fetch_add(1, AtomicOrdering::SeqCst);
  let _ = _cancel_err;

  // Settlement join bound: caller's absolute deadline only. No fresh HASH_CANCEL_JOIN_TIMEOUT
  // after the request budget expires (that would invent extra request-facing wait).
  // When the caller supplied no deadline, use the named join timeout as a cleanup bound.
  let join_deadline = absolute_deadline.unwrap_or_else(|| Instant::now() + HASH_CANCEL_JOIN_TIMEOUT);
  if poll_overlapped_complete(owned_file, overlapped.as_mut(), event, join_deadline) {
    // Completion observed on the initiating handle; free all resources including owned_file.
    release_overlapped_resources(overlapped, buffer, event, owned_file);
    #[cfg(test)]
    CANCEL_IO_COMPLETION_CONFIRMED.fetch_add(1, AtomicOrdering::SeqCst);
    return CancelledIoSettlement::CompletionConfirmed;
  }

  // Still pending: transfer the same owned I/O handle to the reaper. No post-hoc DuplicateHandle.
  #[cfg(test)]
  {
    CANCEL_IO_REAPER_TRANSFERRED.fetch_add(1, AtomicOrdering::SeqCst);
    CANCEL_IO_REAPER_OWNED_HANDLE.fetch_add(1, AtomicOrdering::SeqCst);
  }
  let state = SendableOverlappedState {
    owned_file: owned_file as usize,
    overlapped: Box::into_raw(overlapped) as usize,
    buffer: Box::into_raw(buffer) as usize,
    event: event as usize,
  };
  std::thread::spawn(move || {
    // SAFETY: exclusive ownership transferred from the cancel path; pointers are not aliased.
    // `owned_file` is the initiating I/O handle, owned solely by this reaper.
    let owned_file = state.owned_file as *mut std::ffi::c_void;
    let event = state.event as *mut std::ffi::c_void;
    let mut overlapped = unsafe { Box::from_raw(state.overlapped as *mut HashOverlapped) };
    let buffer = unsafe { Box::from_raw(state.buffer as *mut [u8; HASH_CHUNK_BYTES]) };
    // Reaper cleanup budget is independent of the request deadline (best-effort free only).
    // It never surfaces success to the request path.
    let reaper_deadline = Instant::now() + HASH_CANCEL_REAPER_TIMEOUT;
    if poll_overlapped_complete(owned_file, overlapped.as_mut(), event, reaper_deadline) {
      release_overlapped_resources(overlapped, buffer, event, owned_file);
      #[cfg(test)]
      CANCEL_IO_COMPLETION_CONFIRMED.fetch_add(1, AtomicOrdering::SeqCst);
      return;
    }
    // Still pending after reaper budget: keep state alive (leak intentionally) rather than UAF
    // or an infinite wait. Owned handle + boxes forgotten so OS completion cannot write freed memory.
    std::mem::forget(overlapped);
    std::mem::forget(buffer);
    let _ = (event, owned_file);
  });
  CancelledIoSettlement::OwnershipTransferredToReaper
}

/// Windows: overlapped ReadFile + CancelIoEx. Continuously cancellable; no helper thread to join.
#[cfg(windows)]
fn hash_open_handle_overlapped(
  file: &mut std::fs::File,
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<String, NativeWorkerErrorCode> {
  use std::os::windows::io::AsRawHandle;

  const ERROR_IO_PENDING: u32 = 997;
  const ERROR_HANDLE_EOF: u32 = 38;
  const ERROR_BROKEN_PIPE: u32 = 109;
  const ERROR_OPERATION_ABORTED: u32 = 995;
  const WAIT_OBJECT_0: u32 = 0;
  const WAIT_TIMEOUT: u32 = 0x0000_0102;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CreateEventW(
      attributes: *mut std::ffi::c_void,
      manual_reset: i32,
      initial_state: i32,
      name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn ReadFile(
      file: *mut std::ffi::c_void,
      buffer: *mut u8,
      number_of_bytes_to_read: u32,
      number_of_bytes_read: *mut u32,
      overlapped: *mut HashOverlapped,
    ) -> i32;
    fn GetOverlappedResult(
      file: *mut std::ffi::c_void,
      overlapped: *mut HashOverlapped,
      number_of_bytes_transferred: *mut u32,
      wait: i32,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
    fn ResetEvent(handle: *mut std::ffi::c_void) -> i32;
  }

  // Owned handle must exist before any ReadFile. All poll/GetOverlappedResult/CancelIoEx/reaper
  // paths use this same handle — never a post-hoc DuplicateHandle of the caller's raw handle.
  let handle = match take_owned_io_handle(file.as_raw_handle()) {
    Some(h) => h,
    None => return Err(NativeWorkerErrorCode::RuntimeDigestMismatch),
  };
  // When true, this function still owns `handle` and must CloseHandle it on the way out.
  let mut handle_owned = true;
  let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
  if event.is_null() {
    unsafe {
      let _ = CloseHandle(handle);
    }
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  let mut hasher = Sha256::new();
  // Heap-owned so cancel can transfer ownership to a reaper without UAF on stack frames.
  let mut buffer = Box::new([0u8; HASH_CHUNK_BYTES]);
  let mut offset: u64 = 0;
  // When true, event was moved to a reaper and must not be closed here.
  let mut event_owned = true;

  let result = (|| {
    loop {
      ensure_deadline_and_cancel(deadline, cancel)?;
      unsafe {
        let _ = ResetEvent(event);
      }
      let mut overlapped = Box::new(HashOverlapped {
        internal: 0,
        internal_high: 0,
        offset: offset as u32,
        offset_high: (offset >> 32) as u32,
        event,
      });
      let mut read_n = 0u32;
      let ok = unsafe {
        ReadFile(
          handle,
          buffer.as_mut_ptr(),
          HASH_CHUNK_BYTES as u32,
          &mut read_n,
          overlapped.as_mut(),
        )
      };
      if ok == 0 {
        let err = unsafe { GetLastError() };
        if err == ERROR_HANDLE_EOF || err == ERROR_BROKEN_PIPE {
          break;
        }
        if err != ERROR_IO_PENDING {
          return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
        }
        // Pending: poll for completion while honouring deadline/cancel.
        loop {
          let wait_ms = HASH_HELPER_POLL_INTERVAL.as_millis().min(u32::MAX as u128) as u32;
          let wr = unsafe { WaitForSingleObject(event, wait_ms) };
          if wr == WAIT_OBJECT_0 {
            let got = unsafe { GetOverlappedResult(handle, overlapped.as_mut(), &mut read_n, 0) };
            if got == 0 {
              let e = unsafe { GetLastError() };
              if e == ERROR_HANDLE_EOF || e == ERROR_BROKEN_PIPE {
                read_n = 0;
                break;
              }
              if e == ERROR_OPERATION_ABORTED {
                return Err(NativeWorkerErrorCode::WorkerTimeout);
              }
              return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
            }
            break;
          }
          if wr == WAIT_TIMEOUT {
            if let Err(code) = ensure_deadline_and_cancel(deadline, cancel) {
              // Consume heap state so free never races a still-pending I/O completion.
              // Transfer the same initiating handle; cancel path consumes handle ownership.
              let owned_buffer = std::mem::replace(&mut buffer, Box::new([0u8; HASH_CHUNK_BYTES]));
              let _settlement = cancel_and_release_overlapped(handle, overlapped, owned_buffer, event, deadline);
              handle_owned = false;
              event_owned = false;
              return Err(code);
            }
            continue;
          }
          // Unexpected wait status while I/O may still be pending — settle before returning.
          let owned_buffer = std::mem::replace(&mut buffer, Box::new([0u8; HASH_CHUNK_BYTES]));
          let _settlement = cancel_and_release_overlapped(handle, overlapped, owned_buffer, event, deadline);
          handle_owned = false;
          event_owned = false;
          return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
        }
      }
      if read_n == 0 {
        break;
      }
      hasher.update(&buffer[..read_n as usize]);
      offset = offset.saturating_add(u64::from(read_n));
    }
    Ok(encode_lowercase_hex(&hasher.finalize()))
  })();

  if event_owned {
    unsafe {
      let _ = CloseHandle(event);
    }
  }
  if handle_owned {
    unsafe {
      let _ = CloseHandle(handle);
    }
  }
  result
}

/// Hidden helper subcommand flag shared by the desktop binary and `native_hash_helper`.
pub const NATIVE_HASH_HELPER_ARG: &str = "--langnext-native-hash-helper";

/// Fixed FDs used after spawn remapping (source / result / ready).
const HASH_HELPER_SOURCE_FD: i32 = 3;
const HASH_HELPER_RESULT_FD: i32 = 4;
const HASH_HELPER_READY_FD: i32 = 5;
/// Extra high-FD slot for the locked helper image passed into the child for FD-based exec.
#[cfg(unix)]
const HASH_HELPER_IMAGE_FD_SLOT: i32 = HASH_HELPER_SAFE_FD_BASE + 3;

/// Entry point for the identity-hash helper process (exec only; no host runtime).
/// Reads the source FD to EOF, writes a 32-byte SHA-256 digest to the result FD, and signals ready first.
/// Optional `--probe-fd N` (after closing non-helper FDs) reports `EBADF` or `OPEN` on the result FD
/// so tests can observe the helper's descriptor table directly.
pub fn run_native_hash_helper(args: &[String]) -> ! {
  let mut source_fd = HASH_HELPER_SOURCE_FD;
  let mut result_fd = HASH_HELPER_RESULT_FD;
  let mut ready_fd = HASH_HELPER_READY_FD;
  let mut probe_fd: Option<i32> = None;
  let mut i = 0usize;
  while i < args.len() {
    match args[i].as_str() {
      "--source-fd" => {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
          source_fd = v;
          i += 2;
          continue;
        }
      }
      "--result-fd" => {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
          result_fd = v;
          i += 2;
          continue;
        }
      }
      "--ready-fd" => {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
          ready_fd = v;
          i += 2;
          continue;
        }
      }
      "--probe-fd" => {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
          probe_fd = Some(v);
          i += 2;
          continue;
        }
      }
      NATIVE_HASH_HELPER_ARG => {
        i += 1;
        continue;
      }
      _ => {
        i += 1;
        continue;
      }
    }
    i += 1;
  }

  #[cfg(unix)]
  {
    // Best-effort: drop every FD outside the three helper ends so inherited host state cannot leak.
    close_non_helper_fds(source_fd, result_fd, ready_fd);
    // Signal parent that the helper is alive and about to enter a potentially blocking read.
    let ready_byte = [1u8];
    unsafe {
      let _ = libc::write(ready_fd, ready_byte.as_ptr() as *const _, 1);
      libc::close(ready_fd);
    }

    // Probe mode: report whether a marker FD survived close_non_helper_fds (test-observable).
    if let Some(fd) = probe_fd {
      let status = unsafe { libc::fcntl(fd, libc::F_GETFD) };
      let msg: &[u8] = if status < 0 {
        // errno is almost always EBADF when F_GETFD fails on a closed descriptor.
        b"EBADF"
      } else {
        b"OPEN"
      };
      unsafe {
        let _ = libc::write(result_fd, msg.as_ptr() as *const _, msg.len());
        libc::close(result_fd);
        libc::close(source_fd);
      }
      std::process::exit(0);
    }

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; HASH_CHUNK_BYTES];
    loop {
      let n = unsafe { libc::read(source_fd, buffer.as_mut_ptr() as *mut _, HASH_CHUNK_BYTES) };
      if n < 0 {
        std::process::exit(2);
      }
      if n == 0 {
        break;
      }
      hasher.update(&buffer[..n as usize]);
    }
    let digest = hasher.finalize();
    unsafe {
      let _ = libc::write(result_fd, digest.as_ptr() as *const _, digest.len());
      libc::close(result_fd);
      libc::close(source_fd);
    }
    std::process::exit(0);
  }
  #[cfg(not(unix))]
  {
    let _ = (source_fd, result_fd, ready_fd, probe_fd);
    // Helper is Unix-only; Windows uses in-process CancelIoEx hashing.
    std::process::exit(2);
  }
}

/// Highest FD number to scan when closing inherited descriptors in the helper.
/// Prefer RLIMIT_NOFILE / sysconf(_SC_OPEN_MAX); fall back to a named floor so high FDs close.
#[cfg(unix)]
fn unix_max_closable_fd() -> i32 {
  const OPEN_MAX_FLOOR: i32 = 1024;
  let mut max_fd = OPEN_MAX_FLOOR;
  // sysconf(_SC_OPEN_MAX) is the portable upper bound for open descriptors.
  let sc = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
  if sc > 0 {
    max_fd = max_fd.max(sc as i32);
  }
  let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
  if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
    let soft = limit.rlim_cur;
    if soft > 0 && soft != libc::RLIM_INFINITY {
      max_fd = max_fd.max(soft as i32);
    }
  }
  max_fd
}

#[cfg(unix)]
fn close_non_helper_fds(source_fd: i32, result_fd: i32, ready_fd: i32) {
  let max_fd = unix_max_closable_fd();
  let mut keep = [source_fd, result_fd, ready_fd];
  keep.sort_unstable();

  // Prefer platform close_range / closefrom when available so high FDs are not inherited.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    // close_range is Linux 5.9+; on failure fall through to a closefrom-style loop.
    unsafe extern "C" {
      fn close_range(first: u32, last: u32, flags: u32) -> i32;
    }
    let mut low = 0i32;
    let mut range_ok = true;
    for &fd in &keep {
      if fd > low {
        if unsafe { close_range(low as u32, (fd - 1) as u32, 0) } != 0 {
          range_ok = false;
          break;
        }
      }
      low = fd + 1;
    }
    if range_ok && low <= max_fd {
      if unsafe { close_range(low as u32, max_fd as u32, 0) } == 0 {
        return;
      }
    }
  }

  #[cfg(any(
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  {
    // closefrom(low) closes every FD >= low. Close gaps below the first keep FD first.
    let first_keep = keep[0];
    for fd in 0..first_keep {
      if fd == source_fd || fd == result_fd || fd == ready_fd {
        continue;
      }
      unsafe {
        let _ = libc::close(fd);
      }
    }
    // Close between keep FDs, then closefrom past the last keep FD.
    for window in keep.windows(2) {
      for fd in (window[0] + 1)..window[1] {
        unsafe {
          let _ = libc::close(fd);
        }
      }
    }
    let after_last = keep[2] + 1;
    unsafe extern "C" {
      fn closefrom(lowfd: libc::c_int);
    }
    unsafe {
      closefrom(after_last);
    }
    return;
  }

  // Portable fallback (including macOS): close every FD in [0, max_fd] except the three keeps.
  for fd in 0i32..=max_fd {
    if fd == source_fd || fd == result_fd || fd == ready_fd {
      continue;
    }
    unsafe {
      let _ = libc::close(fd);
    }
  }
}

/// Create a pipe and return (read, write). On failure returns Err without leaking FDs.
#[cfg(unix)]
fn unix_pipe() -> Result<(i32, i32), NativeWorkerErrorCode> {
  let mut fds = [0i32; 2];
  if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  Ok((fds[0], fds[1]))
}

/// Close a set of raw FDs, ignoring errors (cleanup helper).
#[cfg(unix)]
fn unix_close_fds(fds: &[i32]) {
  for &fd in fds {
    if fd >= 0 {
      unsafe {
        let _ = libc::close(fd);
      }
    }
  }
}

/// Open, identity-locked helper image held until the helper process is reaped.
/// Production never treats a bare `current_exe()` path string as secure identity: the open FD +
/// recorded identity is the authority. Linux spawn uses true FD-based exec (`execveat`/`fexecve`),
/// never a replaceable pathname (including `/proc/self/fd/N`).
///
/// Drop order (test + production field layout):
/// 1. `drop_gate` (test-only, first field) — may signal and block while the owned file is still live
/// 2. `file` (`LockedHelperImageFile`) — closes the open file description; under test, clears the
///    live probe then emits the unique drop token after close
/// 3. `identity`, `source_path`
/// Under test an explicit `Drop` takes the gate first so it cannot run after `file` closes.
#[cfg(unix)]
struct LockedHelperImage {
  /// Test-only drop probe/gate. First field + explicit Drop so it runs before the image file closes.
  #[cfg(test)]
  drop_gate: Option<LockedHelperImageDropGate>,
  /// Open executable image (no write intent). Held until waitpid confirms the helper is reaped.
  file: LockedHelperImageFile,
  identity: FileIdentity,
  /// Canonical source path used for diagnostics / test existence checks (not the exec identity).
  source_path: PathBuf,
}

/// Owned helper-image file. Wraps the open `File` so test Drop can clear a live probe and emit a
/// unique token after the open file description is closed. Tests must observe lifecycle through
/// this wrapper — never via process-global raw FD numbers + `F_GETFD`/`fstat` after release.
#[cfg(unix)]
struct LockedHelperImageFile {
  /// `Some` until `Drop` closes the OFD. Option lets Drop close before test token notify.
  file: Option<std::fs::File>,
  /// Test-only shared observer: live probe handle + unique drop-token channel.
  #[cfg(test)]
  drop_observer: Option<std::sync::Arc<OwnedFileDropObserver>>,
}

#[cfg(unix)]
impl LockedHelperImageFile {
  fn new(file: std::fs::File) -> Self {
    Self {
      file: Some(file),
      #[cfg(test)]
      drop_observer: None,
    }
  }

  fn as_file(&self) -> &std::fs::File {
    self
      .file
      .as_ref()
      .expect("LockedHelperImageFile used after Drop took the owned File")
  }
}

#[cfg(unix)]
impl std::ops::Deref for LockedHelperImageFile {
  type Target = std::fs::File;

  fn deref(&self) -> &Self::Target {
    self.as_file()
  }
}

#[cfg(unix)]
impl std::os::unix::io::AsRawFd for LockedHelperImageFile {
  fn as_raw_fd(&self) -> std::os::unix::io::RawFd {
    use std::os::unix::io::AsRawFd;
    self.as_file().as_raw_fd()
  }
}

/// Close OFD first; under test, clear the live probe then send the unique drop token only after
/// the owned file is closed. Token delivery is the sole post-release close signal for tests.
#[cfg(unix)]
impl Drop for LockedHelperImageFile {
  fn drop(&mut self) {
    #[cfg(test)]
    let observer = self.drop_observer.take();
    #[cfg(test)]
    if let Some(ref obs) = observer {
      // Drop the probe dup before the owner FD so the OFD can fully close below.
      obs.clear_live_probe();
    }
    drop(self.file.take());
    #[cfg(test)]
    if let Some(obs) = observer {
      obs.notify_dropped();
    }
  }
}

/// Test-only unique token delivered exactly once when [`LockedHelperImageFile`] drops (after OFD
/// close). Tests wait on this instead of probing a process-global raw FD number.
#[cfg(all(unix, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OwnedFileDropToken(u64);

/// Test-only observer for an owned helper-image file.
/// - While the wrapper is live: `assert_live_with_identity` re-reads identity from a dup of the
///   open handle (not a stashed process-global raw FD number).
/// - On wrapper Drop: live probe is cleared, OFD closes, then the unique token is sent.
#[cfg(all(unix, test))]
struct OwnedFileDropObserver {
  /// Dup of the owned open file while live; `None` once Drop begins clearing the probe.
  live_probe: std::sync::Mutex<Option<std::fs::File>>,
  recorded_identity: FileIdentity,
  token: OwnedFileDropToken,
  drop_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<OwnedFileDropToken>>>,
}

#[cfg(all(unix, test))]
impl OwnedFileDropObserver {
  /// Gate-hold check: wrapper has not dropped and identity is still readable from the owned probe.
  fn assert_live_with_identity(&self, expected: FileIdentity, context: &str) {
    let guard = self.live_probe.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = guard.as_ref().unwrap_or_else(|| {
      panic!("{context}: owned file wrapper already dropped (live probe cleared)");
    });
    let actual = file_identity_from_handle(file).unwrap_or_else(|err| {
      panic!("{context}: identity not readable from owned live probe handle: {err:?}");
    });
    assert_eq!(
      actual, expected,
      "{context}: live probe identity must match expected (got {actual:?}, expected {expected:?})"
    );
    assert_eq!(
      actual, self.recorded_identity,
      "{context}: live probe identity must match identity recorded at observer install"
    );
  }

  fn clear_live_probe(&self) {
    let mut guard = self.live_probe.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    drop(guard.take());
  }

  fn notify_dropped(&self) {
    if let Some(tx) = self
      .drop_tx
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .take()
    {
      let _ = tx.send(self.token);
    }
  }
}

/// Test-only: observes (and optionally holds) `LockedHelperImage` drop.
/// When installed, `started` fires as Drop begins while the owned image file is still live; if
/// `hold_rx` is set, Drop blocks until the test releases it — so success-reap tests can assert
/// the lock is still held after waitpid and only released before reaper completion notify.
#[cfg(all(unix, test))]
struct LockedHelperImageDropGate {
  started_tx: Option<std::sync::mpsc::Sender<()>>,
  hold_rx: Option<std::sync::mpsc::Receiver<()>>,
}

#[cfg(all(unix, test))]
impl Drop for LockedHelperImageDropGate {
  fn drop(&mut self) {
    if let Some(tx) = self.started_tx.take() {
      let _ = tx.send(());
    }
    if let Some(rx) = self.hold_rx.take() {
      // Block until the test allows release (or abandons by dropping the sender).
      let _ = rx.recv();
    }
  }
}

/// Explicit drop order under test: run the gate (may block) while `file` is still live, then let
/// remaining fields drop in declaration order (`file` closes OFD + notifies token).
#[cfg(all(unix, test))]
impl Drop for LockedHelperImage {
  fn drop(&mut self) {
    // Gate first: may block while LockedHelperImageFile + observer remain live.
    if let Some(gate) = self.drop_gate.take() {
      drop(gate);
    }
    // Then field teardown: file (clear probe → close OFD → unique token), identity, source_path.
  }
}

#[cfg(all(unix, test))]
impl LockedHelperImage {
  /// Install a drop gate: `started` fires when drop begins (owned file still live); drop then
  /// blocks until `release` is signaled or the sender is dropped. Production never calls this.
  fn with_drop_gate(mut self, started: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()>) -> Self {
    self.drop_gate = Some(LockedHelperImageDropGate {
      started_tx: Some(started),
      hold_rx: Some(release),
    });
    self
  }

  /// Install a test-only owned-file drop observer. Returns the shared observer for live checks
  /// during a gate hold; after release, wait on `file_dropped` for the unique token (no raw-FD
  /// `F_GETFD`/`fstat` after close).
  fn with_owned_file_drop_observer(
    mut self,
    token: OwnedFileDropToken,
    file_dropped: std::sync::mpsc::Sender<OwnedFileDropToken>,
  ) -> (Self, std::sync::Arc<OwnedFileDropObserver>) {
    let probe = self
      .file
      .as_file()
      .try_clone()
      .expect("dup owned helper image for test drop observer");
    let observer = std::sync::Arc::new(OwnedFileDropObserver {
      live_probe: std::sync::Mutex::new(Some(probe)),
      recorded_identity: self.identity,
      token,
      drop_tx: std::sync::Mutex::new(Some(file_dropped)),
    });
    self.file.drop_observer = Some(std::sync::Arc::clone(&observer));
    (self, observer)
  }
}

/// Linux/Android procfs magic symlinks must not be opened with `O_NOFOLLOW` (kernel returns ELOOP).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn is_linux_proc_magic_symlink(path: &Path) -> bool {
  path == Path::new("/proc/self/exe")
    || path.starts_with(Path::new("/proc/self/fd"))
    || path.starts_with(Path::new("/proc/thread-self/fd"))
}

/// Test-only helper path discovery. Never used as production identity; callers still lock the
/// resulting path through [`lock_helper_image_at`]. Env is read only inside isolated subprocess
/// tests — production never consults these keys.
#[cfg(all(unix, test))]
fn test_only_native_hash_helper_path() -> Option<PathBuf> {
  for key in ["LANGNEXT_NATIVE_HASH_HELPER", "CARGO_BIN_EXE_native_hash_helper"] {
    if let Some(p) = std::env::var_os(key) {
      let path = PathBuf::from(p);
      if path.is_file() {
        return Some(path);
      }
    }
  }
  // Unit tests may not receive CARGO_BIN_EXE_*; locate the package bin under target/.
  let mut candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  candidate.push("target");
  let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
  candidate.push(profile);
  candidate.push(format!("native_hash_helper{}", std::env::consts::EXE_SUFFIX));
  if candidate.is_file() {
    return Some(candidate);
  }
  None
}

/// Open `path`, record identity from the open FD, and hold the FD until the helper is reaped.
/// Regular paths use `O_NOFOLLOW`. Linux procfs magic symlinks (`/proc/self/exe`, `/proc/self/fd/N`)
/// must not use `O_NOFOLLOW` (ELOOP). Never builds a pathname spawn target from the open FD.
#[cfg(unix)]
fn lock_helper_image_at(path: &Path) -> Result<LockedHelperImage, NativeWorkerErrorCode> {
  use std::os::unix::fs::OpenOptionsExt;

  // Magic procfs symlinks: open without O_NOFOLLOW. Regular paths: refuse symlink hops.
  let mut flags = libc::O_CLOEXEC;
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    if !is_linux_proc_magic_symlink(path) {
      flags |= libc::O_NOFOLLOW;
    }
  }
  #[cfg(not(any(target_os = "linux", target_os = "android")))]
  {
    flags |= libc::O_NOFOLLOW;
  }

  let file = std::fs::OpenOptions::new()
    .read(true)
    .custom_flags(flags)
    .open(path)
    .map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
  let meta = file.metadata().map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
  if !meta.is_file() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  let identity = file_identity_from_handle(&file)?;
  // Holding `file` until reap pins the inode; exec uses the FD directly (no replaceable path).
  Ok(LockedHelperImage {
    #[cfg(test)]
    drop_gate: None,
    file: LockedHelperImageFile::new(file),
    identity,
    source_path: path.to_path_buf(),
  })
}

/// Production: lock the running image via `/proc/self/exe` (Linux) or a no-follow open of
/// `current_exe`. Never prefer an unverified same-directory `native_hash_helper` sibling.
/// Never consult env paths for identity.
#[cfg(unix)]
fn lock_production_helper_image() -> Result<LockedHelperImage, NativeWorkerErrorCode> {
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    // `/proc/self/exe` is the kernel's live mapping of this process image — open it directly
    // (without O_NOFOLLOW; see `is_linux_proc_magic_symlink`).
    return lock_helper_image_at(Path::new("/proc/self/exe"));
  }
  #[cfg(not(any(target_os = "linux", target_os = "android")))]
  {
    // Lock may succeed; spawn still fails closed without safe FD exec on these platforms.
    let path = std::env::current_exe().map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    lock_helper_image_at(&path)
  }
}

/// Resolve and lock the helper image used for identity hashing.
/// Test overrides (`LANGNEXT_NATIVE_HASH_HELPER`, `CARGO_BIN_EXE_*`) are `cfg(test)` only and still
/// go through FD/identity locking — never path-only exec.
#[cfg(unix)]
fn lock_native_hash_helper_image() -> Result<LockedHelperImage, NativeWorkerErrorCode> {
  #[cfg(test)]
  {
    if let Some(path) = test_only_native_hash_helper_path() {
      return lock_helper_image_at(&path);
    }
    // Never fall back to the test harness binary: it does not implement the helper protocol.
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  #[cfg(not(test))]
  {
    lock_production_helper_image()
  }
}

/// Test/diagnostic: source path for existence checks. Production code paths must use
/// [`lock_native_hash_helper_image`] and never exec a bare path without the open lock.
#[cfg(unix)]
fn resolve_native_hash_helper_exe() -> Result<PathBuf, NativeWorkerErrorCode> {
  Ok(lock_native_hash_helper_image()?.source_path)
}

/// Unix: fork + FD-based exec of a dedicated helper (never pathname exec of a replaceable path,
/// never fork + Rust hash work in a multi-threaded host). Parent kills/waits on cancel and keeps
/// the locked image FD until the helper is reaped (including background reaper ownership).
#[cfg(unix)]
fn hash_open_handle_helper_process(
  file: &mut std::fs::File,
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<String, NativeWorkerErrorCode> {
  use std::os::unix::io::AsRawFd;

  // result_pipe: helper writes 32-byte digest; ready_pipe: one byte after child starts, before read.
  let (result_read, result_write) = unix_pipe()?;
  let (ready_read, ready_write) = match unix_pipe() {
    Ok(pair) => pair,
    Err(err) => {
      // Pipe creation failure must clean previously opened FDs.
      unix_close_fds(&[result_read, result_write]);
      return Err(err);
    }
  };
  let source_fd = file.as_raw_fd();

  // Lock the helper image (open FD + identity) before spawn. Ownership stays with this stack
  // frame or transfers to the background reaper — never dropped while the child is unreaped.
  let locked_helper = match lock_native_hash_helper_image() {
    Ok(image) => image,
    Err(err) => {
      unix_close_fds(&[result_read, result_write, ready_read, ready_write]);
      return Err(err);
    }
  };

  let image_fd = locked_helper.file.as_raw_fd();
  let pid = match spawn_hash_helper_from_locked_fd(image_fd, source_fd, result_write, ready_write, None) {
    Ok(pid) => pid,
    Err(err) => {
      unix_close_fds(&[result_read, result_write, ready_read, ready_write]);
      drop(locked_helper);
      return Err(err);
    }
  };

  // Parent closes write ends; child owns the remapped copies.
  unix_close_fds(&[result_write, ready_write]);

  // Ready pipe: poll against the caller's absolute deadline only — never invent a fresh
  // request budget after expiry. When no caller deadline is set, use the named join timeout.
  let ready_deadline = deadline.unwrap_or_else(|| Instant::now() + HASH_CANCEL_JOIN_TIMEOUT);
  let ready_ok = loop {
    if let Err(code) = ensure_deadline_and_cancel(Some(ready_deadline), cancel) {
      // Absolute deadline expiry: never add a synchronous 5s request budget; background reap.
      unix_close_fds(&[ready_read, result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(code);
    }
    let mut pollfd = libc::pollfd {
      fd: ready_read,
      events: libc::POLLIN,
      revents: 0,
    };
    let remaining = ready_deadline.saturating_duration_since(Instant::now());
    let wait_ms = remaining
      .min(HASH_HELPER_POLL_INTERVAL)
      .as_millis()
      .min(i32::MAX as u128) as i32;
    let pr = unsafe { libc::poll(&mut pollfd, 1, wait_ms.max(1)) };
    if pr < 0 {
      let errno = std::io::Error::last_os_error();
      if errno.raw_os_error() == Some(libc::EINTR) {
        continue;
      }
      unix_close_fds(&[ready_read, result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    if pr == 0 {
      if Instant::now() >= ready_deadline {
        // Ready deadline hit: cleanup without inventing an extra request budget.
        unix_close_fds(&[ready_read, result_read]);
        unix_cleanup_helper_after_deadline(pid, Some(ready_deadline), locked_helper);
        return Err(NativeWorkerErrorCode::WorkerTimeout);
      }
      continue;
    }
    let mut ready_buf = [0u8; 1];
    let ready_n = unsafe { libc::read(ready_read, ready_buf.as_mut_ptr() as *mut _, 1) };
    if ready_n < 0 {
      let errno = std::io::Error::last_os_error();
      if errno.raw_os_error() == Some(libc::EINTR) {
        continue;
      }
      unix_close_fds(&[ready_read, result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    break ready_n == 1;
  };
  unix_close_fds(&[ready_read]);
  if !ready_ok {
    unix_close_fds(&[result_read]);
    unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  // Poll for digest with deadline/cancel; kill+wait on interrupt so no leftover process remains.
  // Locked image ownership moves into cleanup/reap helpers — never dropped while unreaped.
  let mut digest = [0u8; 32];
  let mut got = 0usize;
  loop {
    if let Err(code) = ensure_deadline_and_cancel(deadline, cancel) {
      // Absolute deadline: background reaper only — never block the request path +5s.
      unix_close_fds(&[result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(code);
    }
    let mut pollfd = libc::pollfd {
      fd: result_read,
      events: libc::POLLIN,
      revents: 0,
    };
    let wait_ms = HASH_HELPER_POLL_INTERVAL.as_millis().min(i32::MAX as u128) as i32;
    let pr = unsafe { libc::poll(&mut pollfd, 1, wait_ms) };
    if pr < 0 {
      let errno = std::io::Error::last_os_error();
      if errno.raw_os_error() == Some(libc::EINTR) {
        continue;
      }
      unix_close_fds(&[result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    if pr == 0 {
      continue;
    }
    let n = unsafe { libc::read(result_read, digest[got..].as_mut_ptr() as *mut _, 32 - got) };
    if n < 0 {
      let errno = std::io::Error::last_os_error();
      if errno.raw_os_error() == Some(libc::EINTR) {
        continue;
      }
      unix_close_fds(&[result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    if n == 0 {
      // EOF before full digest: reap and fail. Full digest on EOF is handled below after read loop.
      if got == 32 {
        unix_close_fds(&[result_read]);
        return unix_reap_helper_after_success(pid, deadline, locked_helper).map(|()| encode_lowercase_hex(&digest));
      }
      unix_close_fds(&[result_read]);
      unix_cleanup_helper_after_deadline(pid, deadline, locked_helper);
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    got += n as usize;
    if got == 32 {
      // Digest success still requires a clean helper exit/reap within the absolute deadline.
      // After the deadline, success is forbidden even if the digest bytes are complete.
      unix_close_fds(&[result_read]);
      return unix_reap_helper_after_success(pid, deadline, locked_helper).map(|()| encode_lowercase_hex(&digest));
    }
  }
}

/// After a successful digest, confirm the helper exits and is reaped within the caller's absolute
/// deadline. Prefer a normal wait; escalate to kill+wait only if the helper lingers.
///
/// - Request-facing wait is bounded by `absolute_deadline` (no invented extra request budget).
/// - Cleanup after the deadline transfers kill/wait **and** `locked_helper` ownership to a
///   long-lived background reaper; never synchronously adds `HASH_CANCEL_JOIN_TIMEOUT` on the
///   request path, and never returns success after the deadline.
/// - When no absolute deadline is supplied, the named join timeout bounds the wait.
/// - `locked_helper` is dropped only after waitpid confirms reap (or on success return).
/// - Bounded `unix_kill_and_wait` Err never drops the lock: ownership moves to the background reaper.
#[cfg(unix)]
fn unix_reap_helper_after_success(
  pid: libc::pid_t,
  absolute_deadline: Option<Instant>,
  locked_helper: LockedHelperImage,
) -> Result<(), NativeWorkerErrorCode> {
  // Already past the request budget: background cleanup only, never success, never +5s sync wait.
  if let Some(deadline) = absolute_deadline {
    if Instant::now() >= deadline {
      unix_kill_reap_in_background(pid, locked_helper);
      return Err(NativeWorkerErrorCode::WorkerTimeout);
    }
  }
  let request_deadline = absolute_deadline.unwrap_or_else(|| Instant::now() + HASH_CANCEL_JOIN_TIMEOUT);
  let enforce_absolute = absolute_deadline.is_some();
  loop {
    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if wr == pid {
      // Helper exited. With an absolute request deadline, success after expiry is forbidden.
      if enforce_absolute && Instant::now() >= request_deadline {
        drop(locked_helper);
        return Err(NativeWorkerErrorCode::WorkerTimeout);
      }
      drop(locked_helper);
      return Ok(());
    }
    if wr < 0 {
      let err = std::io::Error::last_os_error();
      match err.raw_os_error() {
        Some(e) if e == libc::EINTR => continue,
        Some(e) if e == libc::ECHILD => {
          if enforce_absolute && Instant::now() >= request_deadline {
            drop(locked_helper);
            return Err(NativeWorkerErrorCode::WorkerTimeout);
          }
          drop(locked_helper);
          return Ok(()); // already reaped
        }
        _ => {
          // Still transfer ownership so the image FD is not abandoned while a child may exist.
          unix_kill_reap_in_background(pid, locked_helper);
          return Err(NativeWorkerErrorCode::SpawnFailed);
        }
      }
    }
    // wr == 0: still running
    if Instant::now() >= request_deadline {
      // Absolute deadline → background reaper (with locked image), never success.
      // Join-timeout-only path may still finish a short synchronous kill+wait; on Err, hand off.
      if enforce_absolute {
        unix_kill_reap_in_background(pid, locked_helper);
        return Err(NativeWorkerErrorCode::WorkerTimeout);
      }
      return unix_bounded_kill_wait_or_background_reap(
        pid,
        Some(Instant::now() + HASH_CANCEL_JOIN_TIMEOUT),
        locked_helper,
      )
      .map_err(|_| NativeWorkerErrorCode::WorkerTimeout);
    }
    std::thread::sleep(HASH_HELPER_POLL_INTERVAL);
  }
}

/// Request-path cleanup after a deadline/cancel decision.
///
/// - If `absolute_deadline` is set and already expired: transfer kill/wait **and** the locked
///   helper image to a long-lived background reaper immediately (no synchronous +5s budget).
/// - Otherwise: kill+wait bounded by the remaining absolute deadline (or the named join timeout
///   when no absolute deadline was supplied).
/// - `locked_helper` is released only after confirmed reap. Any bounded `unix_kill_and_wait` Err
///   transfers PID + lock to the background reaper — never drops the image while unreaped.
#[cfg(unix)]
fn unix_cleanup_helper_after_deadline(
  pid: libc::pid_t,
  absolute_deadline: Option<Instant>,
  locked_helper: LockedHelperImage,
) {
  if let Some(deadline) = absolute_deadline {
    if Instant::now() >= deadline {
      unix_kill_reap_in_background(pid, locked_helper);
      return;
    }
    let _ = unix_bounded_kill_wait_or_background_reap(pid, Some(deadline), locked_helper);
    return;
  }
  let _ =
    unix_bounded_kill_wait_or_background_reap(pid, Some(Instant::now() + HASH_CANCEL_JOIN_TIMEOUT), locked_helper);
}

/// Bounded kill+wait that releases `locked_helper` only after confirmed reap.
/// On any Err, hands PID + locked image to the background reaper (never drop early).
#[cfg(unix)]
fn unix_bounded_kill_wait_or_background_reap(
  pid: libc::pid_t,
  wait_deadline: Option<Instant>,
  locked_helper: LockedHelperImage,
) -> Result<(), String> {
  match unix_kill_and_wait(pid, wait_deadline) {
    Ok(()) => {
      drop(locked_helper);
      Ok(())
    }
    Err(err) => {
      unix_kill_reap_in_background(pid, locked_helper);
      Err(err)
    }
  }
}

/// Test-only monotonic generation for PID-keyed registrations.
/// Paired with the PID so RAII Drop cannot remove a later registration after PID reuse (ABA).
#[cfg(all(unix, test))]
static UNIX_TEST_REGISTRATION_TOKEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(all(unix, test))]
fn next_unix_test_registration_token() -> u64 {
  UNIX_TEST_REGISTRATION_TOKEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Test-only: PID → registration token for which bounded `unix_kill_and_wait` returns Err after
/// SIGKILL without reaping, so callers must hand PID + locked image to the background reaper.
/// Token-keyed so Drop after PID reuse cannot clear a newer arming (ABA).
#[cfg(all(unix, test))]
static FORCE_UNIX_KILL_AND_WAIT_ERR_PIDS: std::sync::Mutex<HashMap<libc::pid_t, u64>> =
  std::sync::Mutex::new(HashMap::new());

/// RAII guard: force bounded kill+wait Err for a single target PID + unique token.
/// The fault is one-shot: the target `unix_kill_and_wait` consumes it. Drop only removes the
/// entry when PID+token still match — never a later registration that reused the PID.
/// Callers must drop the guard as soon as the target call returns.
#[cfg(all(unix, test))]
struct ForceUnixKillWaitErrGuard {
  pid: libc::pid_t,
  token: u64,
}

#[cfg(all(unix, test))]
impl ForceUnixKillWaitErrGuard {
  fn arm(pid: libc::pid_t) -> Self {
    let token = next_unix_test_registration_token();
    FORCE_UNIX_KILL_AND_WAIT_ERR_PIDS
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .insert(pid, token);
    Self { pid, token }
  }
}

#[cfg(all(unix, test))]
impl Drop for ForceUnixKillWaitErrGuard {
  fn drop(&mut self) {
    let mut map = FORCE_UNIX_KILL_AND_WAIT_ERR_PIDS
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if map.get(&self.pid).copied() == Some(self.token) {
      map.remove(&self.pid);
    }
  }
}

/// Consume a forced kill+wait Err for `pid` (one-shot). Returns true only when an arming was
/// present; removes it so a later PID-reuse registration is unaffected.
#[cfg(all(unix, test))]
fn take_force_unix_kill_and_wait_err_for(pid: libc::pid_t) -> bool {
  FORCE_UNIX_KILL_AND_WAIT_ERR_PIDS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .remove(&pid)
    .is_some()
}

/// Test-only: per-PID completion senders keyed by (pid, token). Each reaper takes its own sender
/// at spawn time so an unrelated reaper cannot consume another test's notification. Drop removes
/// only when PID+token still match, eliminating PID-reuse ABA on unregister.
#[cfg(all(unix, test))]
static UNIX_REAPER_COMPLETION_HOOKS: std::sync::Mutex<
  HashMap<libc::pid_t, (u64, std::sync::mpsc::Sender<libc::pid_t>)>,
> = std::sync::Mutex::new(HashMap::new());

/// RAII completion hook scoped to one helper PID + unique registration token.
#[cfg(all(unix, test))]
struct UnixReaperCompletionHook {
  pid: libc::pid_t,
  token: u64,
  rx: std::sync::mpsc::Receiver<libc::pid_t>,
}

#[cfg(all(unix, test))]
impl UnixReaperCompletionHook {
  /// Install a dedicated completion sender for `pid`. Reaper takes ownership at spawn.
  fn install(pid: libc::pid_t) -> Self {
    let token = next_unix_test_registration_token();
    let (tx, rx) = std::sync::mpsc::channel();
    UNIX_REAPER_COMPLETION_HOOKS
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .insert(pid, (token, tx));
    Self { pid, token, rx }
  }

  fn recv_timeout(&self, timeout: Duration) -> Result<libc::pid_t, std::sync::mpsc::RecvTimeoutError> {
    self.rx.recv_timeout(timeout)
  }

  fn try_recv(&self) -> Result<libc::pid_t, std::sync::mpsc::TryRecvError> {
    self.rx.try_recv()
  }
}

#[cfg(all(unix, test))]
impl Drop for UnixReaperCompletionHook {
  fn drop(&mut self) {
    let mut map = UNIX_REAPER_COMPLETION_HOOKS
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if map.get(&self.pid).map(|(token, _)| *token) == Some(self.token) {
      map.remove(&self.pid);
    }
  }
}

/// Take the dedicated completion sender for `pid` (one-shot, owned by that reaper thread).
#[cfg(all(unix, test))]
fn take_unix_reaper_completion_hook(pid: libc::pid_t) -> Option<std::sync::mpsc::Sender<libc::pid_t>> {
  UNIX_REAPER_COMPLETION_HOOKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .remove(&pid)
    .map(|(_token, tx)| tx)
}

/// Hand kill/wait + locked image ownership to a long-lived background reaper.
/// Request path returns immediately. The reaper holds `locked_helper` until waitpid confirms
/// reap — it never abandons after a fixed budget into a zombie.
#[cfg(unix)]
fn unix_kill_reap_in_background(pid: libc::pid_t, locked_helper: LockedHelperImage) {
  // Test-only: take a PID-scoped dedicated sender so this reaper alone notifies its waiter.
  #[cfg(test)]
  let completion_tx = take_unix_reaper_completion_hook(pid);
  std::thread::spawn(move || {
    let _ = unix_kill_and_wait_until_reaped(pid);
    // Drop only after reap confirmation so the image FD pins the inode for the helper lifetime.
    drop(locked_helper);
    // Test-only: signal completion after waitpid confirmed (tests must not race waitpid).
    #[cfg(test)]
    if let Some(tx) = completion_tx {
      let _ = tx.send(pid);
    }
  });
}

/// Kill a helper and wait until waitpid confirms reap. Never times out into an unreaped zombie.
#[cfg(unix)]
fn unix_kill_and_wait_until_reaped(pid: libc::pid_t) -> Result<(), String> {
  if pid <= 0 {
    return Err(format!("invalid pid {pid}"));
  }
  let kill_rc = unsafe { libc::kill(pid, libc::SIGKILL) };
  let kill_err = if kill_rc != 0 {
    Some(std::io::Error::last_os_error())
  } else {
    None
  };
  if let Some(ref err) = kill_err {
    if err.raw_os_error() != Some(libc::ESRCH) {
      // Continue to waitpid; only success after confirmed reap/ECHILD.
    }
  }
  loop {
    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if wr == pid {
      return Ok(());
    }
    if wr == 0 {
      std::thread::sleep(HASH_HELPER_POLL_INTERVAL);
      continue;
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
      Some(e) if e == libc::EINTR => continue,
      Some(e) if e == libc::ECHILD => {
        if kill_err.as_ref().map(|e| e.raw_os_error()) == Some(Some(libc::ESRCH)) || kill_err.is_none() {
          return Ok(());
        }
        // Child table entry gone; treat as reaped so the reaper can release ownership.
        return Ok(());
      }
      _ => {
        // Transient waitpid failure: keep polling rather than abandoning into a zombie.
        std::thread::sleep(HASH_HELPER_POLL_INTERVAL);
      }
    }
  }
}

/// Dup `fd` to a descriptor >= `min_fd` (F_DUPFD). Used to park source FDs on safe high numbers
/// before spawn remaps them onto 3/4/5 without cross-clobber.
#[cfg(unix)]
fn unix_dup_to_high(fd: i32, min_fd: i32) -> Result<i32, NativeWorkerErrorCode> {
  let duped = unsafe { libc::fcntl(fd, libc::F_DUPFD, min_fd) };
  if duped < 0 {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  Ok(duped)
}

/// Spawn the hash helper from an already-locked executable FD.
///
/// Linux/Android: `fork` + `execveat(AT_EMPTY_PATH)` / `fexecve` — true FD-based exec with no
/// pathname replacement window (including no `/proc/self/fd/N` path).
/// Other Unix: fail closed (no safe FD exec without a replaceable path).
///
/// FD mapping first copies inputs to high FDs so remaps onto 3/4/5 cannot cross-clobber when any
/// of source/result/ready already occupies 3, 4, or 5 (including closed-stdio reuse of 0/1/2).
/// Between fork and exec only async-signal-safe libc calls run (no Rust hash work in the child).
#[cfg(unix)]
fn spawn_hash_helper_from_locked_fd(
  image_fd: i32,
  source_fd: i32,
  result_write: i32,
  ready_write: i32,
  /// Test-only: when set, helper reports whether this FD survived close_non_helper_fds.
  probe_fd: Option<i32>,
) -> Result<libc::pid_t, NativeWorkerErrorCode> {
  #[cfg(not(any(target_os = "linux", target_os = "android")))]
  {
    let _ = (image_fd, source_fd, result_write, ready_write, probe_fd);
    // No safe FD-based exec without opening a pathname replacement window.
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    // argv must be stack/'static only: after fork the parent returns and must not free heap
    // strings the child still needs for execveat (classic fork+exec UAF).
    const ARG0: &[u8] = b"native_hash_helper\0";
    const FLAG: &[u8] = b"--langnext-native-hash-helper\0";
    const SOURCE_FLAG: &[u8] = b"--source-fd\0";
    const SOURCE_VAL: &[u8] = b"3\0";
    const RESULT_FLAG: &[u8] = b"--result-fd\0";
    const RESULT_VAL: &[u8] = b"4\0";
    const READY_FLAG: &[u8] = b"--ready-fd\0";
    const READY_VAL: &[u8] = b"5\0";
    const PROBE_FLAG: &[u8] = b"--probe-fd\0";
    // Decimal probe FD as stack bytes (enough for i32 + NUL). Formatted before fork only.
    let mut probe_val_buf = [0u8; 16];
    let probe_val_ptr: Option<*const libc::c_char> = if let Some(fd) = probe_fd {
      let s = fd.to_string();
      let bytes = s.as_bytes();
      if bytes.len() + 1 > probe_val_buf.len() {
        return Err(NativeWorkerErrorCode::SpawnFailed);
      }
      probe_val_buf[..bytes.len()].copy_from_slice(bytes);
      probe_val_buf[bytes.len()] = 0;
      Some(probe_val_buf.as_ptr() as *const libc::c_char)
    } else {
      None
    };

    // Fixed helper FDs are compile-time constants; keep the c-string tables in sync.
    debug_assert_eq!(HASH_HELPER_SOURCE_FD, 3);
    debug_assert_eq!(HASH_HELPER_RESULT_FD, 4);
    debug_assert_eq!(HASH_HELPER_READY_FD, 5);

    // Stage 1 (parent): park FDs on non-overlapping high numbers before fork.
    let high_source = unix_dup_to_high(source_fd, HASH_HELPER_SAFE_FD_BASE)?;
    let high_result = match unix_dup_to_high(result_write, HASH_HELPER_SAFE_FD_BASE + 1) {
      Ok(fd) => fd,
      Err(err) => {
        unix_close_fds(&[high_source]);
        return Err(err);
      }
    };
    let high_ready = match unix_dup_to_high(ready_write, HASH_HELPER_SAFE_FD_BASE + 2) {
      Ok(fd) => fd,
      Err(err) => {
        unix_close_fds(&[high_source, high_result]);
        return Err(err);
      }
    };
    // Park the locked image FD so remaps onto 3/4/5 cannot clobber the exec identity FD.
    let high_image = match unix_dup_to_high(image_fd, HASH_HELPER_IMAGE_FD_SLOT) {
      Ok(fd) => fd,
      Err(err) => {
        unix_close_fds(&[high_source, high_result, high_ready]);
        return Err(err);
      }
    };

    // argv/envp on the stack: child gets its own stack copy after fork; parent return is safe.
    let mut argv: [*const libc::c_char; 11] = [
      ARG0.as_ptr() as *const libc::c_char,
      FLAG.as_ptr() as *const libc::c_char,
      SOURCE_FLAG.as_ptr() as *const libc::c_char,
      SOURCE_VAL.as_ptr() as *const libc::c_char,
      RESULT_FLAG.as_ptr() as *const libc::c_char,
      RESULT_VAL.as_ptr() as *const libc::c_char,
      READY_FLAG.as_ptr() as *const libc::c_char,
      READY_VAL.as_ptr() as *const libc::c_char,
      std::ptr::null(),
      std::ptr::null(),
      std::ptr::null(),
    ];
    if let Some(probe_ptr) = probe_val_ptr {
      argv[8] = PROBE_FLAG.as_ptr() as *const libc::c_char;
      argv[9] = probe_ptr;
      argv[10] = std::ptr::null();
    }
    let envp: [*const libc::c_char; 1] = [std::ptr::null()];

    let pid = unsafe { libc::fork() };
    if pid < 0 {
      unix_close_fds(&[high_source, high_result, high_ready, high_image]);
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    if pid == 0 {
      // Child: only async-signal-safe operations until exec. Helper closes leftover FDs after exec.
      if unsafe { libc::dup2(high_source, HASH_HELPER_SOURCE_FD) } < 0
        || unsafe { libc::dup2(high_result, HASH_HELPER_RESULT_FD) } < 0
        || unsafe { libc::dup2(high_ready, HASH_HELPER_READY_FD) } < 0
      {
        unsafe { libc::_exit(127) };
      }
      // Close high staging copies when they are not the fixed helper FDs or the exec image FD.
      for &fd in &[high_source, high_result, high_ready] {
        if fd != HASH_HELPER_SOURCE_FD && fd != HASH_HELPER_RESULT_FD && fd != HASH_HELPER_READY_FD && fd != high_image
        {
          unsafe {
            let _ = libc::close(fd);
          }
        }
      }
      // True FD-based exec: no pathname, no `/proc/self/fd/N` replacement window.
      unix_exec_from_image_fd(high_image, argv.as_ptr(), envp.as_ptr());
    }

    // Parent: drop staging FDs; the locked image FD remains in LockedHelperImage until reap.
    // Stack argv/'static strings stay valid for the child independently of this return.
    unix_close_fds(&[high_source, high_result, high_ready, high_image]);
    if pid <= 0 {
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    Ok(pid)
  }
}

/// Replace the current process image from an open executable FD (never returns on success).
/// Prefer `execveat(AT_EMPTY_PATH)`; fall back to `fexecve`. Never falls back to a pathname.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn unix_exec_from_image_fd(image_fd: i32, argv: *const *const libc::c_char, envp: *const *const libc::c_char) -> ! {
  // glibc: execveat is the true AT_EMPTY_PATH path. musl/android: fexecve is FD-based.
  #[cfg(all(target_os = "linux", target_env = "gnu"))]
  unsafe {
    let empty = c"";
    libc::execveat(image_fd, empty.as_ptr(), argv, envp, libc::AT_EMPTY_PATH);
  }
  #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
  unsafe {
    libc::fexecve(image_fd, argv, envp);
  }
  unsafe { libc::_exit(127) };
}

/// Kill a helper child and reap it with correct errno handling.
///
/// - `wait_deadline` is the sole wait bound (callers pass the original absolute deadline or a
///   reaper budget). This function never invents an extra `HASH_CANCEL_JOIN_TIMEOUT` on top.
/// - `EINTR` retries; never treated as success
/// - `ECHILD` means already reaped (success only after a kill that is ESRCH/ok)
/// - kill failure (not ESRCH) propagates
/// - timeout returns Err — never permanent blocking waitpid, never pseudo-success
/// - if `wait_deadline` is already expired: one non-blocking waitpid attempt, then Err
#[cfg(unix)]
fn unix_kill_and_wait(pid: libc::pid_t, wait_deadline: Option<Instant>) -> Result<(), String> {
  if pid <= 0 {
    return Err(format!("invalid pid {pid}"));
  }

  // Test-only: simulate bounded wait failure without reaping so Err handoff paths are exercised.
  // One-shot consume by PID: arming is removed here so a later PID-reuse registration is clean,
  // and the fault guard can drop immediately after the target call returns.
  #[cfg(test)]
  {
    if take_force_unix_kill_and_wait_err_for(pid) {
      let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
      return Err(format!(
        "waitpid timed out for pid {pid} after SIGKILL (forced test timeout)"
      ));
    }
  }

  let kill_rc = unsafe { libc::kill(pid, libc::SIGKILL) };
  let kill_err = if kill_rc != 0 {
    Some(std::io::Error::last_os_error())
  } else {
    None
  };
  if let Some(ref err) = kill_err {
    // ESRCH: already gone — still attempt reap. Any other kill error is fatal unless reap proves gone.
    if err.raw_os_error() != Some(libc::ESRCH) {
      // Continue to waitpid; if we cannot confirm death, surface the kill error.
    }
  }

  // Sole wait bound: caller-supplied deadline, or the named join timeout when none was given.
  // Never add a fresh 5s after an already-expired absolute deadline (caller should background).
  let deadline = wait_deadline.unwrap_or_else(|| Instant::now() + HASH_CANCEL_JOIN_TIMEOUT);
  loop {
    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if wr == pid {
      return Ok(());
    }
    if wr == 0 {
      // Still running / unreaped.
      if Instant::now() >= deadline {
        return Err(format!(
          "waitpid timed out for pid {pid} after SIGKILL (no permanent block)"
        ));
      }
      std::thread::sleep(HASH_HELPER_POLL_INTERVAL);
      continue;
    }
    // wr < 0
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
      Some(e) if e == libc::EINTR => continue,
      Some(e) if e == libc::ECHILD => {
        // Not a child or already reaped. Success only when kill said ESRCH or succeeded.
        if kill_err.as_ref().map(|e| e.raw_os_error()) == Some(Some(libc::ESRCH)) || kill_err.is_none() {
          return Ok(());
        }
        return Err(format!(
          "kill pid {pid} failed ({}); waitpid ECHILD",
          kill_err.as_ref().map(|e| e.to_string()).unwrap_or_default()
        ));
      }
      _ => {
        return Err(format!("waitpid({pid}) failed: {err}"));
      }
    }
  }
}

/// Windows drive types treated as host-local for identity hashing.
#[cfg(windows)]
const DRIVE_REMOVABLE: u32 = 2;
#[cfg(windows)]
const DRIVE_FIXED: u32 = 3;
#[cfg(windows)]
const DRIVE_RAMDISK: u32 = 6;

/// True when a Win32 GetDriveType result is an acceptable local volume.
/// FILE_TYPE_DISK alone is insufficient — network redirectors can still report disk.
#[cfg(windows)]
fn windows_drive_type_is_local(drive_type: u32) -> bool {
  matches!(drive_type, DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_RAMDISK)
}

/// Reject handles that can block a single `Read` forever (pipes, sockets, devices).
/// Also rejects offline/recall cloud attributes. Volume locality is checked separately.
#[cfg(windows)]
fn assert_local_disk_file(file: &std::fs::File) -> Result<(), NativeWorkerErrorCode> {
  use std::os::windows::io::AsRawHandle;

  const FILE_TYPE_DISK: u32 = 0x0001;
  const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
  const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
  const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetFileType(handle: *mut std::ffi::c_void) -> u32;
  }

  let file_type = unsafe { GetFileType(file.as_raw_handle()) };
  if file_type != FILE_TYPE_DISK {
    // Named pipes / devices / unknown: fail closed before a blocking ReadFile.
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  let info = windows_by_handle_info(file)?;
  let remote_or_offline = (info.file_attributes
    & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS))
    != 0;
  if remote_or_offline {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(())
}

/// Fail closed unless the path's volume is a local drive type (not DRIVE_REMOTE).
#[cfg(windows)]
fn assert_local_volume_path(path: &Path) -> Result<(), NativeWorkerErrorCode> {
  use std::os::windows::ffi::OsStrExt;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetVolumePathNameW(file_name: *const u16, volume_path: *mut u16, buffer_length: u32) -> i32;
    fn GetDriveTypeW(root_path: *const u16) -> u32;
  }

  let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
  let mut volume = [0u16; 512];
  let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) };
  if ok == 0 {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  let drive_type = unsafe { GetDriveTypeW(volume.as_ptr()) };
  if !windows_drive_type_is_local(drive_type) {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(())
}

/// Unix counterpart: only regular files may be identity-hashed.
#[cfg(unix)]
fn assert_local_regular_file(file: &std::fs::File) -> Result<(), NativeWorkerErrorCode> {
  use std::os::unix::fs::FileTypeExt;
  let meta = file.metadata().map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
  let ft = meta.file_type();
  if !ft.is_file() || ft.is_fifo() || ft.is_socket() || ft.is_block_device() || ft.is_char_device() {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(())
}

/// Linux/Android local filesystem magic numbers (explicit allowlist; fail closed otherwise).
#[cfg(any(target_os = "linux", target_os = "android", test))]
mod unix_local_fs_magic {
  pub const EXT4_SUPER_MAGIC: i64 = 0xEF53;
  pub const XFS_SUPER_MAGIC: i64 = 0x5846_5342;
  pub const BTRFS_SUPER_MAGIC: i64 = 0x9123_683E;
  pub const TMPFS_MAGIC: i64 = 0x0102_1994;
  pub const F2FS_SUPER_MAGIC: i64 = 0xF2F5_2010;
  pub const EROFS_SUPER_MAGIC: i64 = 0xE0F5_E1E2;
  pub const RAMFS_MAGIC: i64 = 0x8584_58F6;
  pub const REISERFS_SUPER_MAGIC: i64 = 0x5265_4973;
  pub const JFS_SUPER_MAGIC: i64 = 0x3153_464A;
  // OverlayFS is NOT local by itself: upper/lower/work dirs may be remote. Fail closed unless
  // every backing layer is independently verified (not implemented) — never allowlist the magic alone.
  pub const OVERLAYFS_SUPER_MAGIC: i64 = 0x794C_7630;
  // Remote / non-local examples used by fail-closed tests (never allowlisted).
  pub const V9FS_MAGIC: i64 = 0x0102_1997;
  pub const CEPH_SUPER_MAGIC: i64 = 0x00C3_6400;
  pub const NFS_SUPER_MAGIC: i64 = 0x6969;
  pub const FUSE_SUPER_MAGIC: i64 = 0x6573_5546;
}

/// Fail-closed: only explicit local filesystem types may be identity-hashed.
/// `is_file` is not a locality proof. Unknown, 9P, Ceph, NFS, FUSE, OverlayFS, etc. are rejected.
/// OverlayFS is rejected unless full backing-layer verification exists (it does not).
#[cfg(any(target_os = "linux", target_os = "android", test))]
fn unix_fs_type_is_local(fs_type: i64) -> bool {
  use unix_local_fs_magic::*;
  matches!(
    fs_type,
    EXT4_SUPER_MAGIC
      | XFS_SUPER_MAGIC
      | BTRFS_SUPER_MAGIC
      | TMPFS_MAGIC
      | F2FS_SUPER_MAGIC
      | EROFS_SUPER_MAGIC
      | RAMFS_MAGIC
      | REISERFS_SUPER_MAGIC
      | JFS_SUPER_MAGIC
  )
}

/// Fail-closed BSD/macOS fstype allowlist.
#[cfg(any(
  target_os = "macos",
  target_os = "ios",
  target_os = "freebsd",
  target_os = "openbsd",
  target_os = "netbsd",
  test
))]
fn unix_fs_name_is_local(name: &str) -> bool {
  matches!(
    name,
    "apfs" | "hfs" | "hfsplus" | "ufs" | "zfs" | "tmpfs" | "msdos" | "exfat" | "ntfs"
  )
}

/// Fail closed unless the path's mount is on an allowlisted local filesystem.
#[cfg(unix)]
fn assert_local_mount_path(path: &Path) -> Result<(), NativeWorkerErrorCode> {
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
      .map_err(|_| NativeWorkerErrorCode::RuntimeDigestMismatch)?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    let fs_type = i64::from(stat.f_type);
    if !unix_fs_type_is_local(fs_type) {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    return Ok(());
  }
  #[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
  ))]
  {
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
      .map_err(|_| NativeWorkerErrorCode::RuntimeDigestMismatch)?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    // f_fstypename is a fixed char array on BSD/macOS.
    let name_bytes = stat
      .f_fstypename
      .iter()
      .map(|&c| c as u8)
      .take_while(|&c| c != 0)
      .collect::<Vec<_>>();
    let name = String::from_utf8_lossy(&name_bytes).to_ascii_lowercase();
    if !unix_fs_name_is_local(name.as_str()) {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    return Ok(());
  }
  #[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
  )))]
  {
    let _ = path;
    // Unknown Unix: refuse rather than assume local.
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
}

fn open_read_no_write_delete(path: &Path) -> Result<std::fs::File, NativeWorkerErrorCode> {
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    // Volume locality before open — FILE_TYPE_DISK after open is not a local proof.
    assert_local_volume_path(path)?;
    // FILE_SHARE_READ only — deny write/delete while the worker runs.
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    // Open the reparse point itself (if any); never follow it, then reject on handle attributes.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    // FILE_FLAG_OVERLAPPED enables CancelIoEx on pending identity-hash reads (no sync-I/O race).
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    let file = std::fs::OpenOptions::new()
      .read(true)
      .share_mode(FILE_SHARE_READ)
      .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED)
      .open(path)
      .map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    if windows_handle_is_reparse_point(&file)? {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    // Reject pipes/devices/offline/cloud-recall attributes before any hash Read.
    assert_local_disk_file(&file)?;
    Ok(file)
  }
  #[cfg(unix)]
  {
    // Mount locality before open — is_file is not a local proof.
    assert_local_mount_path(path)?;
    // Fail closed on symlink/reparse before retaining the fd for the lock lifetime.
    let meta = std::fs::symlink_metadata(path).map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    if meta.file_type().is_symlink() {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    if !meta.is_file() {
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    let file = std::fs::File::open(path).map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    // Reject FIFOs/devices/sockets: a blocking read has no cancel/deadline seam.
    assert_local_regular_file(&file)?;
    Ok(file)
  }
  #[cfg(not(any(windows, unix)))]
  {
    // Unknown platforms: refuse rather than open with weaker guarantees.
    let _ = path;
    Err(NativeWorkerErrorCode::SpawnFailed)
  }
}

fn open_directory_no_write_delete(path: &Path) -> Result<std::fs::File, NativeWorkerErrorCode> {
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    // FILE_FLAG_BACKUP_SEMANTICS is required to open a directory handle on Windows.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    // Open the directory reparse point itself (if any); never follow it.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let file = std::fs::OpenOptions::new()
      .read(true)
      .share_mode(FILE_SHARE_READ)
      .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
      .open(path)
      .map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    if windows_handle_is_reparse_point(&file)? {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    Ok(file)
  }
  #[cfg(unix)]
  {
    let meta = std::fs::symlink_metadata(path).map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    if meta.file_type().is_symlink() {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    if !meta.is_dir() {
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    std::fs::File::open(path).map_err(|_| NativeWorkerErrorCode::SpawnFailed)
  }
  #[cfg(not(any(windows, unix)))]
  {
    let _ = path;
    Err(NativeWorkerErrorCode::SpawnFailed)
  }
}

fn file_identity_from_handle(file: &std::fs::File) -> Result<FileIdentity, NativeWorkerErrorCode> {
  #[cfg(windows)]
  {
    windows_file_identity(file)
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    Ok(FileIdentity {
      volume_serial: meta.dev(),
      file_index_high: 0,
      file_index_low: meta.ino(),
    })
  }
  #[cfg(not(any(windows, unix)))]
  {
    let _ = file;
    Err(NativeWorkerErrorCode::SpawnFailed)
  }
}

/// Resolve file identity for a loaded module path without following reparse points.
/// Uses one no-follow open; any open/attribute/identity failure is fail-closed (`Err`).
pub fn resolve_path_identity(path: &Path) -> Result<FileIdentity, NativeWorkerErrorCode> {
  let file = open_read_no_write_delete(path)?;
  file_identity_from_handle(&file)
}

/// One loaded module observed in the child process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedModule {
  pub path: PathBuf,
  pub basename: String,
}

/// Audit loaded modules against the locked runtime set.
///
/// Rules:
/// - Main module path must match the locked worker executable (case-insensitive on Windows).
/// - Non-system DLLs must match a locked dependency by basename, path, and volume/file identity.
/// - System / API-set modules are permitted only from `%SystemRoot%\\System32` (or API-set names).
pub fn audit_loaded_modules(locked: &LockedRuntimeSet, modules: &[LoadedModule]) -> Result<(), NativeWorkerErrorCode> {
  audit_loaded_modules_until(locked, modules, None, None)
}

/// Same as [`audit_loaded_modules`] with an absolute wall-clock deadline and optional cancel flag.
pub fn audit_loaded_modules_until(
  locked: &LockedRuntimeSet,
  modules: &[LoadedModule],
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<(), NativeWorkerErrorCode> {
  ensure_deadline_and_cancel(deadline, cancel)?;
  if modules.is_empty() {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  let system_root = std::env::var_os("SystemRoot")
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
  let system32 = system_root.join("System32");

  let worker_canon = normalize_path(&locked.worker_exe.absolute_path);
  let mut saw_worker = false;

  for module in modules {
    ensure_deadline_and_cancel(deadline, cancel)?;
    let basename = module.basename.to_ascii_lowercase();
    let path_norm = normalize_path(&module.path);

    if basename == locked.worker_exe.basename {
      if path_norm != worker_canon {
        return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
      }
      // Force identity comparison; any resolution failure is fail-closed (no check-then-skip race).
      let identity = resolve_path_identity(&module.path)?;
      if identity != locked.worker_exe.identity {
        return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
      }
      saw_worker = true;
      continue;
    }

    // API-set forwarders and any module that actually loads from System32 are system modules.
    if basename.starts_with("api-ms-win-") || basename.starts_with("ext-ms-win-") {
      continue;
    }
    if path_is_under(&path_norm, &system32) {
      // Known system basenames are fine; unknown basenames under System32 are still OS modules.
      let _ = is_windows_system_or_api_set_module(&basename);
      continue;
    }

    // Non-system: must be a locked dependency at the exact locked path + file identity.
    let Some(idx) = locked.by_basename.get(&basename).copied() else {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    };
    let expected = &locked.dependencies[idx];
    let expected_norm = normalize_path(&expected.absolute_path);
    if path_norm != expected_norm {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
    // Force identity comparison for every non-system dependency; resolution failure fails closed.
    let identity = resolve_path_identity(&module.path)?;
    if identity != expected.identity {
      return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
    }
  }

  if !saw_worker {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(())
}

fn normalize_path(path: &Path) -> String {
  let lossy = path.to_string_lossy();
  let mut s = lossy.replace('/', "\\");
  // Strip extended path prefix for comparison.
  if let Some(stripped) = s.strip_prefix(r"\\?\") {
    s = stripped.to_string();
  }
  s.to_ascii_lowercase()
}

fn path_is_under(path_norm: &str, root: &Path) -> bool {
  let root_norm = normalize_path(root);
  path_norm == root_norm || path_norm.starts_with(&(root_norm + "\\"))
}

/// Enumerate modules loaded in `pid` (Windows Toolhelp). Non-Windows returns empty (caller skips audit).
pub fn enumerate_process_modules(pid: u32) -> Result<Vec<LoadedModule>, NativeWorkerErrorCode> {
  enumerate_process_modules_until(pid, None, None)
}

/// Module snapshot with deadline/cancel bookends.
///
/// Toolhelp is a synchronous OS snapshot (not a streaming read). There is no mid-call cancel
/// seam; we fail closed if the budget is already exhausted, refuse empty results, and re-check
/// cancel/deadline immediately after the snapshot returns so a slow/hung host cannot proceed.
pub fn enumerate_process_modules_until(
  pid: u32,
  deadline: Option<Instant>,
  cancel: Option<&crate::domain::cancel::CancelToken>,
) -> Result<Vec<LoadedModule>, NativeWorkerErrorCode> {
  ensure_deadline_and_cancel(deadline, cancel)?;
  #[cfg(windows)]
  {
    let modules = windows_enumerate_modules(pid)?;
    ensure_deadline_and_cancel(deadline, cancel)?;
    Ok(modules)
  }
  #[cfg(not(windows))]
  {
    let _ = pid;
    ensure_deadline_and_cancel(deadline, cancel)?;
    Ok(Vec::new())
  }
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

/// Win32 BY_HANDLE_FILE_INFORMATION layout (FILETIME is two DWORDs to avoid padding).
#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ByHandleFileInformation {
  file_attributes: u32,
  creation_time_low: u32,
  creation_time_high: u32,
  last_access_time_low: u32,
  last_access_time_high: u32,
  last_write_time_low: u32,
  last_write_time_high: u32,
  volume_serial_number: u32,
  file_size_high: u32,
  file_size_low: u32,
  number_of_links: u32,
  file_index_high: u32,
  file_index_low: u32,
}

#[cfg(windows)]
fn windows_by_handle_info(file: &std::fs::File) -> Result<ByHandleFileInformation, NativeWorkerErrorCode> {
  use std::os::windows::io::AsRawHandle;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut ByHandleFileInformation) -> i32;
  }

  let mut info = ByHandleFileInformation::default();
  let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
  if ok == 0 {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  Ok(info)
}

/// Attribute check on the already-open handle (same open that refuses reparse follow).
#[cfg(windows)]
fn windows_handle_is_reparse_point(file: &std::fs::File) -> Result<bool, NativeWorkerErrorCode> {
  let info = windows_by_handle_info(file)?;
  Ok((info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
}

#[cfg(windows)]
fn windows_file_identity(file: &std::fs::File) -> Result<FileIdentity, NativeWorkerErrorCode> {
  let info = windows_by_handle_info(file)?;
  // Fail closed if the open handle is a reparse point (defense in depth after open flags).
  if (info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(FileIdentity {
    volume_serial: u64::from(info.volume_serial_number),
    file_index_high: u64::from(info.file_index_high),
    file_index_low: u64::from(info.file_index_low),
  })
}

#[cfg(windows)]
fn windows_enumerate_modules(pid: u32) -> Result<Vec<LoadedModule>, NativeWorkerErrorCode> {
  use std::mem::{size_of, zeroed};

  const TH32CS_SNAPMODULE: u32 = 0x0000_0008;
  const TH32CS_SNAPMODULE32: u32 = 0x0000_0010;
  const MAX_MODULE_NAME32: usize = 255;
  const MAX_PATH: usize = 260;

  #[repr(C)]
  #[allow(non_snake_case)]
  struct ModuleEntry32W {
    dw_size: u32,
    th32_module_id: u32,
    th32_process_id: u32,
    glblcnt_usage: u32,
    proccnt_usage: u32,
    mod_base_addr: *mut u8,
    mod_base_size: u32,
    h_module: *mut std::ffi::c_void,
    sz_module: [u16; MAX_MODULE_NAME32 + 1],
    sz_exe_path: [u16; MAX_PATH],
  }

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut std::ffi::c_void;
    fn Module32FirstW(snapshot: *mut std::ffi::c_void, entry: *mut ModuleEntry32W) -> i32;
    fn Module32NextW(snapshot: *mut std::ffi::c_void, entry: *mut ModuleEntry32W) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
  }

  unsafe {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if snap.is_null() || snap == (-1isize as *mut std::ffi::c_void) {
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    let mut entry: ModuleEntry32W = zeroed();
    entry.dw_size = size_of::<ModuleEntry32W>() as u32;
    let mut out = Vec::new();
    if Module32FirstW(snap, &mut entry) != 0 {
      loop {
        let path = widestr_to_path(&entry.sz_exe_path);
        let basename = widestr_to_string(&entry.sz_module).to_ascii_lowercase();
        out.push(LoadedModule { path, basename });
        if Module32NextW(snap, &mut entry) == 0 {
          break;
        }
      }
    }
    let _ = CloseHandle(snap);
    if out.is_empty() {
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    Ok(out)
  }
}

#[cfg(windows)]
fn widestr_to_string(buf: &[u16]) -> String {
  let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
  String::from_utf16_lossy(&buf[..len])
}

#[cfg(windows)]
fn widestr_to_path(buf: &[u16]) -> PathBuf {
  PathBuf::from(widestr_to_string(buf))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_package::sha256_hex;
  use std::sync::{Mutex, OnceLock};
  use tempfile::TempDir;

  /// Serializes every test that mutates process-global env, low FDs (3/4/5), or stdio.
  /// Parallel cargo tests must not race these mutations.
  fn process_global_mutation_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK
      .get_or_init(|| Mutex::new(()))
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Env key set on isolated re-exec children so the body runs only once per process.
  const ISOLATED_SUBPROCESS_ENV: &str = "LANGNEXT_MODULE_AUDIT_ISOLATED";

  /// Run `body` in a fresh subprocess (or in-process when already isolated).
  /// Used for global FD mutation so the parent harness never sees closed stdio / remapped 3/4/5.
  fn run_in_isolated_subprocess(token: &str, body: impl FnOnce()) {
    if std::env::var_os(ISOLATED_SUBPROCESS_ENV).as_deref() == Some(std::ffi::OsStr::new(token)) {
      // Child: hold the global lock as a belt-and-suspenders against nested parallel runs.
      let _guard = process_global_mutation_lock();
      body();
      return;
    }
    let test_name = std::thread::current()
      .name()
      .expect("cargo test thread name required for isolated re-exec")
      .to_string();
    let exe = std::env::current_exe().expect("current_exe");
    let output = std::process::Command::new(&exe)
      .arg("--exact")
      .arg(&test_name)
      .arg("--nocapture")
      .env(ISOLATED_SUBPROCESS_ENV, token)
      .env("RUST_TEST_THREADS", "1")
      .output()
      .expect("spawn isolated subprocess");
    assert!(
      output.status.success(),
      "isolated subprocess {token} failed (test={test_name}):\nstdout:\n{}\nstderr:\n{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }

  #[test]
  fn module_audit_accepts_worker_and_system_modules() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    let dll = dir.path().join("helper.dll");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    std::fs::write(&dll, b"dll-bytes").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let dll_sha = sha256_hex(b"dll-bytes");
    let locked =
      lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[("helper.dll".into(), dll_sha)]).expect("lock");
    let modules = vec![
      LoadedModule {
        path: worker.clone(),
        basename: "worker.exe".into(),
      },
      LoadedModule {
        path: dll.clone(),
        basename: "helper.dll".into(),
      },
      LoadedModule {
        path: PathBuf::from(r"C:\Windows\System32\kernel32.dll"),
        basename: "kernel32.dll".into(),
      },
      LoadedModule {
        path: PathBuf::from(r"C:\Windows\System32\api-ms-win-core-synch-l1-2-0.dll"),
        basename: "api-ms-win-core-synch-l1-2-0.dll".into(),
      },
    ];
    audit_loaded_modules(&locked, &modules).expect("audit ok");
  }

  #[test]
  fn module_audit_rejects_undeclared_non_system_dll() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let locked = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect("lock");
    let modules = vec![
      LoadedModule {
        path: worker,
        basename: "worker.exe".into(),
      },
      LoadedModule {
        path: PathBuf::from(r"C:\evil\injected.dll"),
        basename: "injected.dll".into(),
      },
    ];
    let err = audit_loaded_modules(&locked, &modules).expect_err("injected");
    assert_eq!(err, NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  #[test]
  fn module_audit_rejects_worker_path_mismatch() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let locked = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect("lock");
    let modules = vec![LoadedModule {
      path: PathBuf::from(r"C:\other\worker.exe"),
      basename: "worker.exe".into(),
    }];
    let err = audit_loaded_modules(&locked, &modules).expect_err("path mismatch");
    assert_eq!(err, NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  #[test]
  fn module_audit_rejects_system_named_dll_outside_system32() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let locked = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect("lock");
    let modules = vec![
      LoadedModule {
        path: worker,
        basename: "worker.exe".into(),
      },
      // Hijack: kernel32 name but not under System32 and not a locked dependency.
      LoadedModule {
        path: PathBuf::from(r"C:\Temp\kernel32.dll"),
        basename: "kernel32.dll".into(),
      },
    ];
    let err = audit_loaded_modules(&locked, &modules).expect_err("hijacked system dll");
    assert_eq!(err, NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  #[test]
  fn lock_runtime_set_records_file_identity_and_directory_handle() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"MZ-worker-identity").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker-identity");
    let locked = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect("lock");
    assert_ne!(locked.worker_exe.identity.volume_serial, 0);
    assert!(
      locked.worker_exe.identity.file_index_high != 0 || locked.worker_exe.identity.file_index_low != 0,
      "file index must be non-zero"
    );
    assert_ne!(locked.runtime_dir.identity, locked.worker_exe.identity);
    let resolved = resolve_path_identity(&worker).expect("resolve");
    assert_eq!(resolved, locked.worker_exe.identity);
  }

  #[test]
  fn lock_runtime_set_hashes_through_open_handle_not_path_reread() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"handle-hash-v1").unwrap();
    let expected = sha256_hex(b"handle-hash-v1");
    let locked = lock_runtime_set(dir.path(), "worker.exe", &expected, &[]).expect("lock");
    assert_eq!(locked.worker_exe.sha256, expected);
  }

  #[test]
  fn lock_runtime_set_rejects_symlink_worker() {
    let dir = TempDir::new().unwrap();
    let real = dir.path().join("real-worker.exe");
    let link = dir.path().join("worker.exe");
    std::fs::write(&real, b"MZ-worker").unwrap();
    #[cfg(windows)]
    {
      // Prefer a file symlink when the process has SeCreateSymbolicLinkPrivilege.
      // If privilege is missing, fall back to a directory-junction-as-worker path is invalid;
      // force the environment: silent skip would false-green the reparse guard.
      if std::os::windows::fs::symlink_file(&real, &link).is_err() {
        // Junction cannot stand in for a file; require the privilege explicitly.
        panic!(
          "Windows test environment must allow file symlink creation (mklink /D not applicable for files). \
           Enable Developer Mode or SeCreateSymbolicLinkPrivilege; do not skip this guard."
        );
      }
    }
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(&real, &link).unwrap();
    }
    #[cfg(not(any(windows, unix)))]
    {
      panic!("symlink rejection test requires windows or unix");
    }
    let worker_sha = sha256_hex(b"MZ-worker");
    let err = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect_err("symlink");
    assert_eq!(err, NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  #[test]
  fn lock_model_set_retains_model_root_directory_handle() {
    let dir = TempDir::new().unwrap();
    let model_root = dir.path().join("model");
    std::fs::create_dir_all(&model_root).unwrap();
    let marker = b"model-marker";
    std::fs::write(model_root.join("marker.bin"), marker).unwrap();
    let locked = lock_model_set(&model_root, &[("marker.bin".into(), sha256_hex(marker))]).expect("lock model");
    assert_ne!(locked.model_root.identity.volume_serial, 0);
    assert_eq!(locked.files.len(), 1);
    assert_eq!(locked.files[0].sha256, sha256_hex(marker));
  }

  #[test]
  fn module_audit_fails_closed_when_worker_identity_unresolvable() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let mut locked = lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[]).expect("lock");
    // Path comparison passes only when absolute_path matches the loaded module path. Point both
    // at a missing file so identity resolution must fail closed instead of being skipped.
    let missing = dir.path().join("does-not-exist-worker.exe");
    locked.worker_exe.absolute_path = missing.clone();
    locked.worker_exe.basename = "does-not-exist-worker.exe".into();
    let modules = vec![LoadedModule {
      path: missing,
      basename: "does-not-exist-worker.exe".into(),
    }];
    let err = audit_loaded_modules(&locked, &modules).expect_err("unresolvable worker identity");
    assert!(
      matches!(
        err,
        NativeWorkerErrorCode::SpawnFailed | NativeWorkerErrorCode::RuntimeDigestMismatch
      ),
      "must fail closed, got {err:?}"
    );
  }

  #[test]
  fn module_audit_fails_closed_when_dependency_identity_mismatches() {
    let dir = TempDir::new().unwrap();
    let worker = dir.path().join("worker.exe");
    let dll = dir.path().join("helper.dll");
    let impostor = dir.path().join("impostor.dll");
    std::fs::write(&worker, b"MZ-worker").unwrap();
    std::fs::write(&dll, b"dll-bytes-v1").unwrap();
    std::fs::write(&impostor, b"dll-bytes-OTHER").unwrap();
    let worker_sha = sha256_hex(b"MZ-worker");
    let dll_sha = sha256_hex(b"dll-bytes-v1");
    let mut locked =
      lock_runtime_set(dir.path(), "worker.exe", &worker_sha, &[("helper.dll".into(), dll_sha)]).expect("lock");
    // Make path comparison pass while identity still refers to the locked helper.dll contents.
    locked.dependencies[0].absolute_path = impostor.clone();
    let modules = vec![
      LoadedModule {
        path: worker,
        basename: "worker.exe".into(),
      },
      LoadedModule {
        path: impostor,
        basename: "helper.dll".into(),
      },
    ];
    let err = audit_loaded_modules(&locked, &modules).expect_err("identity mismatch");
    assert_eq!(err, NativeWorkerErrorCode::RuntimeDigestMismatch);
  }

  #[test]
  fn resolve_path_identity_rejects_missing_path_fail_closed() {
    let dir = TempDir::new().unwrap();
    let missing = dir.path().join("no-such-module.dll");
    let err = resolve_path_identity(&missing).expect_err("missing path");
    assert!(
      matches!(
        err,
        NativeWorkerErrorCode::SpawnFailed | NativeWorkerErrorCode::RuntimeDigestMismatch
      ),
      "unexpected code {err:?}"
    );
  }

  /// Mid-path reparse/junction must fail closed: component-by-component no-follow resolution
  /// rejects the intermediate link instead of following it to an impostor payload.
  #[test]
  fn lock_runtime_set_rejects_intermediate_reparse_component() {
    let dir = TempDir::new().unwrap();
    let real_mid = dir.path().join("real-mid");
    let evil_mid = dir.path().join("evil-mid");
    std::fs::create_dir_all(&real_mid).unwrap();
    std::fs::create_dir_all(&evil_mid).unwrap();
    // Real tree has the expected worker; evil tree has a different payload.
    std::fs::write(real_mid.join("worker.exe"), b"MZ-real-worker").unwrap();
    std::fs::write(evil_mid.join("worker.exe"), b"MZ-evil-worker").unwrap();

    let link_mid = dir.path().join("mid");
    if !create_dir_reparse(&evil_mid, &link_mid) {
      // Junction creation (mklink /J) does not require admin on Windows; failure means the
      // environment cannot exercise the guard — fail the test rather than silent skip.
      panic!(
        "test environment must create a directory reparse/junction (Windows: mklink /J); \
         intermediate reparse rejection cannot be skipped"
      );
    }

    let worker_sha = sha256_hex(b"MZ-real-worker");
    let err = lock_runtime_set(dir.path(), "mid/worker.exe", &worker_sha, &[]).expect_err("mid reparse");
    assert_eq!(
      err,
      NativeWorkerErrorCode::RuntimeDigestMismatch,
      "intermediate reparse must fail closed, got {err:?}"
    );
  }

  /// Nested model path with an intermediate reparse must also fail closed.
  #[test]
  fn lock_model_set_rejects_intermediate_reparse_component() {
    let dir = TempDir::new().unwrap();
    let model_root = dir.path().join("model");
    std::fs::create_dir_all(&model_root).unwrap();
    let real_nested = model_root.join("real-nested");
    let evil_nested = model_root.join("evil-nested");
    std::fs::create_dir_all(&real_nested).unwrap();
    std::fs::create_dir_all(&evil_nested).unwrap();
    std::fs::write(real_nested.join("marker.bin"), b"model-real").unwrap();
    std::fs::write(evil_nested.join("marker.bin"), b"model-evil").unwrap();

    let link_nested = model_root.join("nested");
    if !create_dir_reparse(&evil_nested, &link_nested) {
      panic!(
        "test environment must create a directory reparse/junction (Windows: mklink /J); \
         model intermediate reparse rejection cannot be skipped"
      );
    }

    let err = lock_model_set(&model_root, &[("nested/marker.bin".into(), sha256_hex(b"model-real"))])
      .expect_err("model mid reparse");
    assert!(
      matches!(
        err,
        NativeWorkerErrorCode::RuntimeDigestMismatch | NativeWorkerErrorCode::ModelDigestMismatch
      ),
      "intermediate model reparse must fail closed, got {err:?}"
    );
  }

  /// Hashing must observe the absolute deadline between chunks (slow identity path).
  #[test]
  fn lock_runtime_set_until_respects_deadline_during_hash() {
    let dir = TempDir::new().unwrap();
    // Large enough that multi-chunk hashing gives the deadline a chance to fire.
    let payload = vec![0xABu8; 2 * 1024 * 1024];
    let worker = dir.path().join("worker.exe");
    std::fs::write(&worker, &payload).unwrap();
    let worker_sha = sha256_hex(&payload);
    let deadline = Instant::now(); // already expired
    let err = lock_runtime_set_until(dir.path(), "worker.exe", &worker_sha, &[], Some(deadline), None)
      .expect_err("expired deadline");
    assert_eq!(err, NativeWorkerErrorCode::WorkerTimeout);
  }

  /// Nested relative paths under a clean tree still lock successfully (positive control).
  #[test]
  fn lock_runtime_set_locks_nested_relative_without_reparse() {
    let dir = TempDir::new().unwrap();
    let nested = dir.path().join("runtime");
    std::fs::create_dir_all(&nested).unwrap();
    let worker = nested.join("worker.exe");
    std::fs::write(&worker, b"MZ-nested").unwrap();
    let worker_sha = sha256_hex(b"MZ-nested");
    let locked = lock_runtime_set(dir.path(), "runtime/worker.exe", &worker_sha, &[]).expect("lock nested");
    assert_eq!(locked.worker_exe.sha256, worker_sha);
    assert!(
      !locked._intermediate_dirs.is_empty(),
      "must retain intermediate dir locks"
    );
  }

  /// Single-blocking-source architecture test: a pipe/FIFO handle must be rejected before hash.
  /// Ordinary local disk files cannot construct an indefinite single-read block; the verifiable
  /// guarantee is that non-disk sources never enter the hash loop (no fake sleep-based timeout).
  #[test]
  fn lock_runtime_set_rejects_blocking_pipe_source_fail_closed() {
    let started = Instant::now();
    let err = reject_blocking_pipe_source();
    let elapsed = started.elapsed();
    assert!(
      matches!(
        err,
        NativeWorkerErrorCode::RuntimeDigestMismatch | NativeWorkerErrorCode::SpawnFailed
      ),
      "blocking pipe/FIFO must fail closed before hash, got {err:?}"
    );
    assert!(
      elapsed < std::time::Duration::from_secs(3),
      "pipe rejection must not hang on a blocking Read; elapsed={elapsed:?}"
    );
  }

  /// Even if a blocking source reaches the hash path, deadline must cancel OS I/O after the read
  /// is proven pending, with no leftover helper thread/process (Windows CancelIoEx / Unix kill+wait).
  #[test]
  fn blocked_identity_hash_io_cancels_on_deadline_and_joins_helper() {
    let started = Instant::now();
    let deadline = Instant::now() + Duration::from_millis(200);
    let err = hash_blocking_source_after_pending_then_deadline(deadline);
    let elapsed = started.elapsed();
    assert_eq!(
      err,
      NativeWorkerErrorCode::WorkerTimeout,
      "blocked identity I/O must surface worker_timeout, got {err:?}"
    );
    assert!(
      elapsed < Duration::from_secs(3),
      "cancellable hash must not hang after deadline; elapsed={elapsed:?}"
    );
  }

  /// Owned I/O handle is taken before any ReadFile and remains valid after the caller's raw
  /// handle is closed. Reaper/poll paths must use this pre-owned handle, never a post-hoc
  /// DuplicateHandle after I/O is already pending.
  #[cfg(windows)]
  #[test]
  fn owned_io_handle_is_taken_before_readfile_and_outlives_caller() {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut std::ffi::c_void,
        disposition: u32,
        flags: u32,
        template: *mut std::ffi::c_void,
      ) -> *mut std::ffi::c_void;
      fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
      fn GetFileType(handle: *mut std::ffi::c_void) -> u32;
    }

    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const FILE_TYPE_UNKNOWN: u32 = 0;

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("owned-handle.bin");
    std::fs::write(&path, b"owned").unwrap();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let raw = unsafe {
      CreateFileW(
        wide.as_ptr(),
        GENERIC_READ,
        FILE_SHARE_READ,
        ptr::null_mut(),
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        ptr::null_mut(),
      )
    };
    assert!(!raw.is_null());
    // Pre-ReadFile ownership acquisition (production path).
    let owned = take_owned_io_handle(raw).expect("owned I/O handle must be taken before ReadFile");
    assert_ne!(owned, raw, "owned handle must be distinct from the caller's raw handle");
    // Closing the original must leave the pre-owned handle usable for poll/reaper.
    unsafe {
      let _ = CloseHandle(raw);
    }
    let file_type = unsafe { GetFileType(owned) };
    assert_ne!(
      file_type, FILE_TYPE_UNKNOWN,
      "owned handle must remain valid after caller CloseHandle"
    );
    unsafe {
      let _ = CloseHandle(owned);
    }
  }

  /// CancelIoEx while I/O is pending must confirm completion (or transfer to a reaper) before
  /// OVERLAPPED/buffer/event are released — never free while ERROR_IO_INCOMPLETE.
  #[cfg(windows)]
  #[test]
  fn cancel_io_ex_pending_lifecycle_confirms_completion_before_free() {
    use std::ptr;
    use std::sync::atomic::Ordering as AtomicOrdering;

    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const ERROR_IO_PENDING: u32 = 997;
    const WAIT_TIMEOUT: u32 = 0x0000_0102;

    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer: u32,
        in_buffer: u32,
        default_timeout: u32,
        security: *mut std::ffi::c_void,
      ) -> *mut std::ffi::c_void;
      fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut std::ffi::c_void,
        disposition: u32,
        flags: u32,
        template: *mut std::ffi::c_void,
      ) -> *mut std::ffi::c_void;
      fn CreateEventW(
        attributes: *mut std::ffi::c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
      ) -> *mut std::ffi::c_void;
      fn ReadFile(
        file: *mut std::ffi::c_void,
        buffer: *mut u8,
        number_of_bytes_to_read: u32,
        number_of_bytes_read: *mut u32,
        overlapped: *mut HashOverlapped,
      ) -> i32;
      fn GetLastError() -> u32;
      fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
      fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }

    let before_confirmed = CANCEL_IO_COMPLETION_CONFIRMED.load(AtomicOrdering::SeqCst);

    let name = format!("\\\\.\\pipe\\langnext-cancel-lifecycle-{}", std::process::id());
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let server = unsafe {
      CreateNamedPipeW(
        wide.as_ptr(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_WAIT,
        1,
        4096,
        4096,
        0,
        ptr::null_mut(),
      )
    };
    assert!(!server.is_null(), "CreateNamedPipeW failed");
    let client = unsafe {
      CreateFileW(
        wide.as_ptr(),
        GENERIC_READ | GENERIC_WRITE,
        0,
        ptr::null_mut(),
        OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED,
        ptr::null_mut(),
      )
    };
    assert!(!client.is_null(), "CreateFileW client failed");

    // Take owned I/O handle BEFORE ReadFile — cancel/reaper must use this same handle.
    let owned_io = take_owned_io_handle(client).expect("owned handle before ReadFile");
    assert_ne!(
      owned_io, client,
      "owned I/O handle must be distinct from caller raw handle"
    );

    let event = unsafe { CreateEventW(ptr::null_mut(), 1, 0, ptr::null()) };
    assert!(!event.is_null());
    let mut buffer = Box::new([0u8; HASH_CHUNK_BYTES]);
    let mut overlapped = Box::new(HashOverlapped {
      internal: 0,
      internal_high: 0,
      offset: 0,
      offset_high: 0,
      event,
    });
    let mut read_n = 0u32;
    // Initiate I/O only on the pre-owned handle (production contract).
    let ok = unsafe { ReadFile(owned_io, buffer.as_mut_ptr(), 1, &mut read_n, overlapped.as_mut()) };
    assert_eq!(ok, 0, "owned-handle read should not complete synchronously");
    assert_eq!(
      unsafe { GetLastError() },
      ERROR_IO_PENDING,
      "owned-handle read must be pending"
    );
    let wr = unsafe { WaitForSingleObject(event, 20) };
    assert_eq!(wr, WAIT_TIMEOUT, "owned-handle read must stay pending");

    let before_checked = CANCEL_IO_CANCEL_IOEX_CHECKED.load(AtomicOrdering::SeqCst);
    let before_owned = CANCEL_IO_REAPER_OWNED_HANDLE.load(AtomicOrdering::SeqCst);
    // Already-expired absolute deadline: settlement must not invent a fresh request join budget.
    let absolute_deadline = Some(Instant::now());
    // Production settlement: same owned handle; no post-hoc DuplicateHandle.
    let settlement = cancel_and_release_overlapped(owned_io, overlapped, buffer, event, absolute_deadline);
    assert!(
      matches!(
        settlement,
        CancelledIoSettlement::CompletionConfirmed | CancelledIoSettlement::OwnershipTransferredToReaper
      ),
      "settlement must confirm completion or transfer ownership, got {settlement:?}"
    );
    let after_checked = CANCEL_IO_CANCEL_IOEX_CHECKED.load(AtomicOrdering::SeqCst);
    assert!(
      after_checked > before_checked,
      "CancelIoEx result must be observed (checked={before_checked}->{after_checked})"
    );
    if settlement == CancelledIoSettlement::CompletionConfirmed {
      let after_confirmed = CANCEL_IO_COMPLETION_CONFIRMED.load(AtomicOrdering::SeqCst);
      assert!(
        after_confirmed > before_confirmed,
        "cancel lifecycle must confirm completion (confirmed={before_confirmed}->{after_confirmed})"
      );
      // owned_io was closed by settlement; caller raw handle is still ours.
      unsafe {
        let _ = CloseHandle(client);
      }
    } else {
      // Reaper path: calling thread returned without permanent GetOverlappedResult(TRUE).
      let transferred = CANCEL_IO_REAPER_TRANSFERRED.load(AtomicOrdering::SeqCst);
      assert!(transferred > 0, "reaper transfer counter must advance");
      let after_owned = CANCEL_IO_REAPER_OWNED_HANDLE.load(AtomicOrdering::SeqCst);
      assert!(
        after_owned > before_owned,
        "reaper must receive the pre-owned initiating handle (owned={before_owned}->{after_owned})"
      );
      // Closing the caller's raw handle must be safe: reaper holds the initiating owned handle.
      unsafe {
        let _ = CloseHandle(client);
      }
      // Give the reaper a moment to settle; never assert permanent blocking wait.
      std::thread::sleep(Duration::from_millis(100));
    }

    unsafe {
      let _ = CloseHandle(server);
    }
  }

  /// Unix locality is an explicit local allowlist: 9P, Ceph, OverlayFS, and unknown magic fail closed.
  #[test]
  fn unix_locality_allowlist_rejects_9p_ceph_and_unknown() {
    use super::unix_local_fs_magic::*;
    assert!(super::unix_fs_type_is_local(EXT4_SUPER_MAGIC));
    assert!(super::unix_fs_type_is_local(XFS_SUPER_MAGIC));
    assert!(super::unix_fs_type_is_local(TMPFS_MAGIC));
    assert!(!super::unix_fs_type_is_local(V9FS_MAGIC), "9P must be rejected");
    assert!(!super::unix_fs_type_is_local(CEPH_SUPER_MAGIC), "Ceph must be rejected");
    assert!(!super::unix_fs_type_is_local(NFS_SUPER_MAGIC), "NFS must be rejected");
    assert!(!super::unix_fs_type_is_local(FUSE_SUPER_MAGIC), "FUSE must be rejected");
    assert!(
      !super::unix_fs_type_is_local(0x1234_5678),
      "unknown magic must be rejected"
    );
    assert!(!super::unix_fs_name_is_local("9p"));
    assert!(!super::unix_fs_name_is_local("ceph"));
    assert!(!super::unix_fs_name_is_local("nfs"));
    assert!(!super::unix_fs_name_is_local("fuse"));
    assert!(super::unix_fs_name_is_local("apfs"));
  }

  /// OverlayFS is fail-closed: upper/lower/work may be remote; no backing-layer verification exists.
  #[test]
  fn overlayfs_is_rejected_without_backing_layer_verification() {
    use super::unix_local_fs_magic::*;
    assert!(
      !super::unix_fs_type_is_local(OVERLAYFS_SUPER_MAGIC),
      "OverlayFS must be fail-closed unless every backing layer is verified"
    );
  }

  /// Drive-type classifier: remote volumes fail closed; fixed/removable/ramdisk are local.
  #[cfg(windows)]
  #[test]
  fn windows_drive_type_locality_classifier() {
    assert!(windows_drive_type_is_local(DRIVE_FIXED));
    assert!(windows_drive_type_is_local(DRIVE_REMOVABLE));
    assert!(windows_drive_type_is_local(DRIVE_RAMDISK));
    assert!(!windows_drive_type_is_local(0)); // UNKNOWN
    assert!(!windows_drive_type_is_local(1)); // NO_ROOT_DIR
    assert!(!windows_drive_type_is_local(4)); // DRIVE_REMOTE
    assert!(!windows_drive_type_is_local(5)); // DRIVE_CDROM
  }

  /// Temp-dir paths on the host must pass local volume/mount checks (positive control).
  #[test]
  fn local_temp_path_passes_volume_or_mount_locality() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("local.bin");
    std::fs::write(&path, b"local-bytes").unwrap();
    #[cfg(windows)]
    assert_local_volume_path(&path).expect("temp volume must be local");
    #[cfg(unix)]
    assert_local_mount_path(&path).expect("temp mount must be local");
  }

  /// Hash a real blocking source after the read is proven pending, then hit the deadline.
  /// Windows: overlapped named-pipe read reaches ERROR_IO_PENDING before CancelIoEx.
  /// Unix: helper process signals ready before blocking on the pipe, then is kill+wait reaped.
  fn hash_blocking_source_after_pending_then_deadline(deadline: Instant) -> NativeWorkerErrorCode {
    #[cfg(windows)]
    {
      use std::os::windows::io::FromRawHandle;
      use std::ptr;

      const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
      const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
      const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
      const PIPE_WAIT: u32 = 0x0000_0000;
      const GENERIC_READ: u32 = 0x8000_0000;
      const GENERIC_WRITE: u32 = 0x4000_0000;
      const OPEN_EXISTING: u32 = 3;
      const ERROR_IO_PENDING: u32 = 997;
      const WAIT_TIMEOUT: u32 = 0x0000_0102;

      #[repr(C)]
      struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut std::ffi::c_void,
      }

      #[link(name = "kernel32")]
      unsafe extern "system" {
        fn CreateNamedPipeW(
          name: *const u16,
          open_mode: u32,
          pipe_mode: u32,
          max_instances: u32,
          out_buffer: u32,
          in_buffer: u32,
          default_timeout: u32,
          security: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
        fn CreateFileW(
          name: *const u16,
          access: u32,
          share: u32,
          security: *mut std::ffi::c_void,
          disposition: u32,
          flags: u32,
          template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
        fn CreateEventW(
          attributes: *mut std::ffi::c_void,
          manual_reset: i32,
          initial_state: i32,
          name: *const u16,
        ) -> *mut std::ffi::c_void;
        fn ReadFile(
          file: *mut std::ffi::c_void,
          buffer: *mut u8,
          number_of_bytes_to_read: u32,
          number_of_bytes_read: *mut u32,
          overlapped: *mut Overlapped,
        ) -> i32;
        fn GetLastError() -> u32;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
      }

      // Unique pipe name per test run.
      let name = format!("\\\\.\\pipe\\langnext-hash-cancel-{}", std::process::id());
      let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
      let server = unsafe {
        CreateNamedPipeW(
          wide.as_ptr(),
          PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
          PIPE_TYPE_BYTE | PIPE_WAIT,
          1,
          4096,
          4096,
          0,
          ptr::null_mut(),
        )
      };
      assert!(!server.is_null(), "CreateNamedPipeW failed");
      let client = unsafe {
        CreateFileW(
          wide.as_ptr(),
          GENERIC_READ | GENERIC_WRITE,
          0,
          ptr::null_mut(),
          OPEN_EXISTING,
          FILE_FLAG_OVERLAPPED,
          ptr::null_mut(),
        )
      };
      assert!(!client.is_null(), "CreateFileW client failed");

      // Prove a read is pending before exercising the production cancel path.
      let event = unsafe { CreateEventW(ptr::null_mut(), 1, 0, ptr::null()) };
      assert!(!event.is_null());
      let mut probe_buf = [0u8; 1];
      let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        event,
      };
      let mut read_n = 0u32;
      let ok = unsafe { ReadFile(client, probe_buf.as_mut_ptr(), 1, &mut read_n, &mut overlapped) };
      assert_eq!(ok, 0, "probe read should not complete synchronously");
      assert_eq!(unsafe { GetLastError() }, ERROR_IO_PENDING, "read must be pending");
      // Confirm still pending briefly (no data written on server).
      let wr = unsafe { WaitForSingleObject(event, 20) };
      assert_eq!(wr, WAIT_TIMEOUT, "probe read must stay pending");
      // Cancel the probe so the handle is clean for the production hasher.
      #[link(name = "kernel32")]
      unsafe extern "system" {
        fn CancelIoEx(file: *mut std::ffi::c_void, overlapped: *mut Overlapped) -> i32;
        fn GetOverlappedResult(
          file: *mut std::ffi::c_void,
          overlapped: *mut Overlapped,
          number_of_bytes_transferred: *mut u32,
          wait: i32,
        ) -> i32;
      }
      unsafe {
        let _ = CancelIoEx(client, &mut overlapped);
        let _ = WaitForSingleObject(event, 2000);
        let mut n = 0u32;
        let _ = GetOverlappedResult(client, &mut overlapped, &mut n, 0);
        let _ = CloseHandle(event);
      }

      let mut read_file = unsafe { std::fs::File::from_raw_handle(client) };
      let _server_keep = unsafe { std::fs::File::from_raw_handle(server) };
      // Production path: overlapped hash must cancel after deadline with no leftover I/O/thread.
      hash_open_handle_overlapped(&mut read_file, Some(deadline), None)
        .expect_err("blocking overlapped hash must fail on deadline")
    }
    #[cfg(unix)]
    {
      use std::os::unix::io::FromRawFd;
      let mut fds = [0i32; 2];
      let prc = unsafe { libc::pipe(fds.as_mut_ptr()) };
      assert_eq!(prc, 0, "pipe failed");
      // Read blocks while write end stays open — helper process signals ready then blocks.
      let mut read_file = unsafe { std::fs::File::from_raw_fd(fds[0]) };
      let _write_keep = unsafe { std::fs::File::from_raw_fd(fds[1]) };
      hash_open_handle_helper_process(&mut read_file, Some(deadline), None)
        .expect_err("blocking helper-process hash must fail on deadline")
    }
    #[cfg(not(any(windows, unix)))]
    {
      let _ = deadline;
      NativeWorkerErrorCode::SpawnFailed
    }
  }

  /// Construct a real pipe/FIFO and exercise the production fail-closed gate used by identity open.
  fn reject_blocking_pipe_source() -> NativeWorkerErrorCode {
    #[cfg(windows)]
    {
      use std::os::windows::io::{FromRawHandle, OwnedHandle};
      use std::ptr;

      #[link(name = "kernel32")]
      unsafe extern "system" {
        fn CreatePipe(
          read_pipe: *mut *mut std::ffi::c_void,
          write_pipe: *mut *mut std::ffi::c_void,
          security: *mut std::ffi::c_void,
          size: u32,
        ) -> i32;
      }

      let mut read_h: *mut std::ffi::c_void = ptr::null_mut();
      let mut write_h: *mut std::ffi::c_void = ptr::null_mut();
      let ok = unsafe { CreatePipe(&mut read_h, &mut write_h, ptr::null_mut(), 0) };
      assert!(ok != 0 && !read_h.is_null() && !write_h.is_null(), "CreatePipe failed");
      // SAFETY: CreatePipe returns owned handles; File/OwnedHandle take ownership.
      let read_file = unsafe { std::fs::File::from_raw_handle(read_h) };
      let _write_keep = unsafe { OwnedHandle::from_raw_handle(write_h) };
      // A Read on this handle would block forever without a writer payload. The gate must reject
      // FILE_TYPE_PIPE before any hash Read runs.
      match assert_local_disk_file(&read_file) {
        Ok(()) => panic!("pipe handle must not pass assert_local_disk_file"),
        Err(code) => code,
      }
    }
    #[cfg(unix)]
    {
      let dir = TempDir::new().unwrap();
      let fifo = dir.path().join("blocking.fifo");
      let path_c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
      let rc = unsafe { libc::mkfifo(path_c.as_ptr(), 0o600) };
      assert_eq!(rc, 0, "mkfifo failed");
      // Production open: metadata rejects non-regular files; assert_local_regular_file is backup.
      match open_read_no_write_delete(&fifo) {
        Ok(_) => panic!("FIFO must not be accepted as a hashable runtime file"),
        Err(code) => code,
      }
    }
    #[cfg(not(any(windows, unix)))]
    {
      NativeWorkerErrorCode::SpawnFailed
    }
  }

  /// Windows reserved device basenames that must never be used as temp path segments.
  fn is_windows_reserved_device_name(name: &str) -> bool {
    matches!(
      name.to_ascii_uppercase().as_str(),
      "CON"
        | "PRN"
        | "AUX"
        | "NUL"
        | "COM1"
        | "COM2"
        | "COM3"
        | "COM4"
        | "COM5"
        | "COM6"
        | "COM7"
        | "COM8"
        | "COM9"
        | "LPT1"
        | "LPT2"
        | "LPT3"
        | "LPT4"
        | "LPT5"
        | "LPT6"
        | "LPT7"
        | "LPT8"
        | "LPT9"
    )
  }

  /// Create a directory reparse (directory symlink/junction on Windows, symlink on Unix).
  /// Uses cross-platform tempfile paths from the caller; never shells out or creates a `NUL` file.
  /// Returns false when the platform refuses creation so the caller can fail the test (never silent skip).
  fn create_dir_reparse(target: &Path, link: &Path) -> bool {
    if let Some(name) = link.file_name().and_then(|n| n.to_str()) {
      if is_windows_reserved_device_name(name) {
        return false;
      }
    }
    #[cfg(windows)]
    {
      use std::os::windows::ffi::OsStrExt;
      // CreateSymbolicLinkW without a shell; ALLOW_UNPRIVILEGED_CREATE works under Developer Mode.
      const SYMBOLIC_LINK_FLAG_DIRECTORY: u32 = 0x1;
      const SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE: u32 = 0x2;

      #[link(name = "kernel32")]
      unsafe extern "system" {
        fn CreateSymbolicLinkW(symlink: *const u16, target: *const u16, flags: u32) -> i32;
      }

      let link_wide: Vec<u16> = link.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
      let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
      let ok = unsafe {
        CreateSymbolicLinkW(
          link_wide.as_ptr(),
          target_wide.as_ptr(),
          SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE,
        )
      };
      ok != 0
    }
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(not(any(windows, unix)))]
    {
      let _ = (target, link);
      false
    }
  }

  /// Second pipe failure must close the first pipe's FDs (no leak of prior ends).
  #[cfg(unix)]
  #[test]
  fn unix_pipe_pair_creation_cleans_prior_fds_on_second_failure() {
    // Direct contract: unix_pipe success, then simulated cleanup path used when the second pipe fails.
    let (r1, w1) = unix_pipe().expect("first pipe");
    // Emulate the production failure branch that closes prior FDs before returning Err.
    unix_close_fds(&[r1, w1]);
    // After close, further use of the FDs must fail (EBADF) — proves they were actually closed.
    let mut buf = [0u8; 1];
    let n = unsafe { libc::read(r1, buf.as_mut_ptr() as *mut _, 1) };
    assert_eq!(n, -1, "closed read fd must not succeed");
    let err = std::io::Error::last_os_error();
    assert_eq!(
      err.raw_os_error(),
      Some(libc::EBADF),
      "expected EBADF after cleanup, got {err}"
    );
  }

  /// unix_kill_and_wait must reap a live child, handle already-dead PIDs, and never pseudo-succeed on timeout.
  #[cfg(unix)]
  #[test]
  fn unix_kill_and_wait_reaps_live_child_and_rejects_invalid_pid() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang.rs");
    let exe = dir.path().join("hang");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile hang");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn hang");
    let pid = child.id() as i32;
    // Forget the std Child so we own waitpid (otherwise std reaps and we get ECHILD races).
    std::mem::forget(child);
    unix_kill_and_wait(pid, Some(Instant::now() + HASH_CANCEL_JOIN_TIMEOUT)).expect("kill+wait live child");
    // Second call: ESRCH + ECHILD should still be Ok (already gone / reaped).
    unix_kill_and_wait(pid, Some(Instant::now() + HASH_CANCEL_JOIN_TIMEOUT)).expect("already-reaped child is Ok");
    // Invalid pid must error (never silent Ok).
    let err = unix_kill_and_wait(0, None).expect_err("pid 0 must fail");
    assert!(err.contains("invalid"), "got {err}");
  }

  /// Helper process path must use the dedicated binary (posix_spawn/exec), not fork+Rust hash.
  #[cfg(unix)]
  #[test]
  fn hash_helper_resolves_dedicated_or_self_executable() {
    let path = resolve_native_hash_helper_exe().expect("resolve helper");
    assert!(path.is_file(), "helper path must exist: {path:?}");
    let current = std::env::current_exe().expect("current_exe");
    // Must never fall back to the unit-test harness (it lacks the helper subcommand protocol).
    if path == current {
      let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
      assert!(
        !name.contains("module_audit") && !name.contains("langnext_app_lib-"),
        "must not resolve to the test harness binary: {path:?}"
      );
    }
  }

  /// Production resolution never consults LANGNEXT_NATIVE_HASH_HELPER / CARGO_BIN_EXE_*.
  /// Env mutation runs only inside an isolated subprocess — never in the test harness process.
  #[cfg(unix)]
  #[test]
  fn production_helper_resolve_ignores_env_overrides() {
    run_in_isolated_subprocess("helper_env_ignore", || {
      // Even if env points at an existing path, production resolution must not read it.
      let dir = TempDir::new().unwrap();
      let decoy = dir.path().join("decoy-helper");
      std::fs::write(&decoy, b"not-a-helper").unwrap();
      // SAFETY: env mutation is confined to this isolated subprocess.
      unsafe {
        std::env::set_var("LANGNEXT_NATIVE_HASH_HELPER", &decoy);
        std::env::set_var("CARGO_BIN_EXE_native_hash_helper", &decoy);
      }
      let locked = lock_production_helper_image().expect("production lock");
      assert_ne!(
        locked.source_path, decoy,
        "production must not trust env helper overrides, got {:?}",
        locked.source_path
      );
      #[cfg(any(target_os = "linux", target_os = "android"))]
      {
        let expected = lock_helper_image_at(Path::new("/proc/self/exe")).expect("expected image");
        assert_eq!(
          locked.identity, expected.identity,
          "production identity must match the live process image"
        );
        drop(expected);
      }
      #[cfg(not(any(target_os = "linux", target_os = "android")))]
      {
        let current = std::env::current_exe().expect("current_exe");
        let expected = lock_helper_image_at(&current).expect("expected image");
        assert_eq!(
          locked.identity, expected.identity,
          "production identity must match current_exe image"
        );
        drop(expected);
      }
      drop(locked);
    });
  }

  /// Production never prefers an unverified same-directory `native_hash_helper` sibling.
  /// Uses locked image identity — never a bare current_exe path string as security identity.
  #[cfg(unix)]
  #[test]
  fn production_helper_never_prefers_unverified_sibling() {
    let locked = lock_production_helper_image().expect("production lock");
    let current = std::env::current_exe().expect("current_exe");
    // Even when a sibling helper file exists next to current_exe, production must ignore it.
    if let Some(parent) = current.parent() {
      let sibling = parent.join(format!("native_hash_helper{}", std::env::consts::EXE_SUFFIX));
      assert_ne!(
        locked.source_path, sibling,
        "production must not prefer unverified same-directory helper {sibling:?}"
      );
    }
    drop(locked);
  }

  /// Linux: locking `/proc/self/exe` must not use O_NOFOLLOW (magic symlink → ELOOP).
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[test]
  fn linux_proc_self_exe_lock_avoids_nofollow_eloop() {
    let locked = lock_helper_image_at(Path::new("/proc/self/exe")).expect("lock /proc/self/exe");
    assert_eq!(locked.source_path, Path::new("/proc/self/exe"));
    // Identity must be readable from the held FD (fstat), not via a pathname re-open race.
    let via_fd = file_identity_from_handle(&locked.file).expect("identity from locked FD");
    assert_eq!(via_fd, locked.identity);
    drop(locked);
  }

  /// Non-Linux Unix without safe FD exec must fail closed (no pathname replacement window).
  #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
  #[test]
  fn non_linux_unix_fd_exec_fails_closed() {
    let locked = lock_native_hash_helper_image().expect("lock may succeed");
    let image_fd = {
      use std::os::unix::io::AsRawFd;
      locked.file.as_raw_fd()
    };
    let (result_r, result_w) = unix_pipe().expect("result pipe");
    let (ready_r, ready_w) = unix_pipe().expect("ready pipe");
    let err = spawn_hash_helper_from_locked_fd(image_fd, result_r, result_w, ready_w, None)
      .expect_err("must not pathname-spawn on non-Linux Unix");
    assert_eq!(err, NativeWorkerErrorCode::SpawnFailed);
    unix_close_fds(&[result_r, result_w, ready_r, ready_w]);
    drop(locked);
  }

  /// Locked helper image pins the executable inode (open FD + identity) for the helper lifetime.
  #[cfg(unix)]
  #[test]
  fn helper_image_lock_records_identity_and_holds_open_fd() {
    use std::os::unix::io::AsRawFd;

    let locked = lock_native_hash_helper_image().expect("lock helper");
    assert!(locked.source_path.is_file() || locked.source_path.exists());
    // Held FD must remain valid and match the recorded identity (no pathname spawn target).
    let fd = locked.file.as_raw_fd();
    assert!(fd >= 0);
    let via_fd = file_identity_from_handle(&locked.file).expect("identity from locked FD");
    assert_eq!(via_fd, locked.identity, "locked FD must resolve to recorded identity");
    drop(locked);
  }

  /// Linux tests must actually FD-exec the helper protocol and produce a real digest.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[test]
  fn hash_helper_executes_real_protocol_and_returns_digest() {
    let helper = resolve_native_hash_helper_exe().expect("real helper required (no harness fallback)");
    assert!(helper.is_file(), "helper missing: {helper:?}");
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("payload.bin");
    let payload = b"langnext-helper-protocol-bytes";
    std::fs::write(&path, payload).unwrap();
    let mut file = std::fs::File::open(&path).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let digest = hash_open_handle_helper_process(&mut file, Some(deadline), None)
      .expect("helper protocol must hash via posix_spawn");
    assert_eq!(digest, sha256_hex(payload));
  }

  /// FD remap must survive source/result/ready already occupying 3/4/5 (cross-clobber case).
  /// All pipe/source endpoints are parked above 5 before any remap so low FDs cannot destroy
  /// endpoints the parent still needs. Global FD mutation runs in an isolated subprocess.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[test]
  fn fd_exec_remap_handles_fixed_fd_overlap() {
    run_in_isolated_subprocess("fd_overlap", || {
      use std::os::unix::io::AsRawFd;

      let dir = TempDir::new().unwrap();
      let path = dir.path().join("overlap.bin");
      std::fs::write(&path, b"overlap-payload").unwrap();
      let file = std::fs::File::open(&path).unwrap();

      let (raw_result_r, raw_result_w) = unix_pipe().expect("result pipe");
      let (raw_ready_r, raw_ready_w) = unix_pipe().expect("ready pipe");

      // Park EVERY endpoint above fixed helper FDs 3/4/5 before any remapping. Common pipe
      // allocation can place result_r=4/result_w=5; remapping onto 4/5 would destroy them.
      const PARK_MIN_FD: i32 = HASH_HELPER_READY_FD + 1; // >5
      let parked_source = unix_dup_to_high(file.as_raw_fd(), PARK_MIN_FD).expect("park source");
      let parked_result_w = unix_dup_to_high(raw_result_w, PARK_MIN_FD).expect("park result write");
      let parked_ready_w = unix_dup_to_high(raw_ready_w, PARK_MIN_FD).expect("park ready write");
      let parked_result_r = unix_dup_to_high(raw_result_r, PARK_MIN_FD).expect("park result read");
      let parked_ready_r = unix_dup_to_high(raw_ready_r, PARK_MIN_FD).expect("park ready read");
      assert!(parked_source > HASH_HELPER_READY_FD);
      assert!(parked_result_w > HASH_HELPER_READY_FD);
      assert!(parked_ready_w > HASH_HELPER_READY_FD);
      assert!(parked_result_r > HASH_HELPER_READY_FD);
      assert!(parked_ready_r > HASH_HELPER_READY_FD);

      // Low originals are no longer needed; close before touching 3/4/5.
      unix_close_fds(&[raw_result_r, raw_result_w, raw_ready_r, raw_ready_w]);

      // Now safe: place parked copies onto fixed helper FDs (cannot clobber parked parent ends).
      let source_on_3 = unsafe { libc::dup2(parked_source, HASH_HELPER_SOURCE_FD) };
      let result_on_4 = unsafe { libc::dup2(parked_result_w, HASH_HELPER_RESULT_FD) };
      let ready_on_5 = unsafe { libc::dup2(parked_ready_w, HASH_HELPER_READY_FD) };
      assert_eq!(source_on_3, HASH_HELPER_SOURCE_FD);
      assert_eq!(result_on_4, HASH_HELPER_RESULT_FD);
      assert_eq!(ready_on_5, HASH_HELPER_READY_FD);
      // Staging dups of source/write ends can close; parent keeps parked read ends.
      unix_close_fds(&[parked_source, parked_result_w, parked_ready_w]);

      let locked = lock_native_hash_helper_image().expect("helper");
      let pid = spawn_hash_helper_from_locked_fd(
        locked.file.as_raw_fd(),
        HASH_HELPER_SOURCE_FD,
        HASH_HELPER_RESULT_FD,
        HASH_HELPER_READY_FD,
        None,
      )
      .expect("spawn with overlapping fixed FDs");

      // Parent reads from parked read ends (never the low FDs that were remapped).
      let mut ready = [0u8; 1];
      let mut pollfd = libc::pollfd {
        fd: parked_ready_r,
        events: libc::POLLIN,
        revents: 0,
      };
      let pr = unsafe { libc::poll(&mut pollfd, 1, 5000) };
      assert!(pr > 0, "ready must arrive under FD overlap");
      let n = unsafe { libc::read(parked_ready_r, ready.as_mut_ptr() as *mut _, 1) };
      assert_eq!(n, 1, "ready byte");
      unix_close_fds(&[parked_ready_r]);
      drop(file);

      let mut digest = [0u8; 32];
      let mut got = 0usize;
      let deadline = Instant::now() + Duration::from_secs(5);
      while got < 32 && Instant::now() < deadline {
        let mut p = libc::pollfd {
          fd: parked_result_r,
          events: libc::POLLIN,
          revents: 0,
        };
        let _ = unsafe { libc::poll(&mut p, 1, 100) };
        let n = unsafe { libc::read(parked_result_r, digest[got..].as_mut_ptr() as *mut _, 32 - got) };
        if n > 0 {
          got += n as usize;
        } else if n == 0 {
          break;
        }
      }
      unix_close_fds(&[parked_result_r]);
      assert_eq!(got, 32, "full digest under FD overlap");
      assert_eq!(encode_lowercase_hex(&digest), sha256_hex(b"overlap-payload"));
      unix_reap_helper_after_success(pid, Some(deadline), locked).expect("reap after success");
    });
  }

  /// Closed stdio (0/1/2) must not break helper spawn/FD remap.
  /// Isolated subprocess owns the stdio close so the parent harness is never polluted.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[test]
  fn fd_exec_helper_works_with_closed_stdio() {
    run_in_isolated_subprocess("closed_stdio", || {
      let dir = TempDir::new().unwrap();
      let path = dir.path().join("closed-stdio.bin");
      std::fs::write(&path, b"closed-stdio-payload").unwrap();

      unsafe {
        let _ = libc::close(0);
        let _ = libc::close(1);
        let _ = libc::close(2);
      }

      let mut file = std::fs::File::open(&path).expect("open after closed stdio");
      // After closing stdio, the open file may land on FD 0/1/2; high-FD staging must still remap.
      let digest = hash_open_handle_helper_process(&mut file, Some(Instant::now() + Duration::from_secs(10)), None)
        .expect("helper must work with closed stdio");
      assert_eq!(digest, sha256_hex(b"closed-stdio-payload"));
    });
  }

  /// High FDs above the helper set must not be inherited by the helper process.
  /// The real helper probes the marker FD with F_GETFD and reports EBADF/OPEN — parent-only
  /// checks cannot prove the child's descriptor table was scrubbed.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[test]
  fn helper_does_not_inherit_high_fds() {
    run_in_isolated_subprocess("high_fd_probe", || {
      use std::os::unix::io::AsRawFd;

      let dir = TempDir::new().unwrap();
      let marker = dir.path().join("high-fd-marker");
      std::fs::write(&marker, b"secret").unwrap();
      let marker_file = std::fs::File::open(&marker).unwrap();
      // Dup marker to a high FD that would leak without CLOEXEC/closefrom/helper close.
      let high_fd = unsafe { libc::fcntl(marker_file.as_raw_fd(), libc::F_DUPFD, 200) };
      assert!(high_fd >= 200, "need high FD, got {high_fd}");

      // Probe via the real helper: after close_non_helper_fds the marker must be EBADF in-child.
      let report = spawn_helper_probe_fd(high_fd).expect("helper probe");
      assert_eq!(
        report, "EBADF",
        "helper must report marker FD closed (EBADF), got {report:?}"
      );

      // Parent high FD must remain open (child closed its copy, not ours).
      let mut buf = [0u8; 1];
      let n = unsafe { libc::read(high_fd, buf.as_mut_ptr() as *mut _, 1) };
      assert_eq!(n, 1, "parent high FD must remain open");
      unsafe {
        let _ = libc::close(high_fd);
      }
      drop(marker_file);
    });
  }

  /// Spawn the real hash helper with `--probe-fd` so it reports the marker FD status after
  /// close_non_helper_fds. Returns the UTF-8 report (`EBADF` or `OPEN`).
  #[cfg(any(target_os = "linux", target_os = "android"))]
  fn spawn_helper_probe_fd(probe_fd: i32) -> Result<String, String> {
    use std::os::unix::io::AsRawFd;

    // Dummy source so fixed FD 3 is a valid open file (helper closes it after probe).
    let dir = TempDir::new().map_err(|e| e.to_string())?;
    let dummy = dir.path().join("probe-source.bin");
    std::fs::write(&dummy, b"x").map_err(|e| e.to_string())?;
    let source_file = std::fs::File::open(&dummy).map_err(|e| e.to_string())?;

    let (result_r, result_w) = unix_pipe().map_err(|_| "result pipe".to_string())?;
    let (ready_r, ready_w) = unix_pipe().map_err(|_| "ready pipe".to_string())?;

    let locked = lock_native_hash_helper_image().map_err(|_| "lock helper".to_string())?;
    let pid = spawn_hash_helper_from_locked_fd(
      locked.file.as_raw_fd(),
      source_file.as_raw_fd(),
      result_w,
      ready_w,
      Some(probe_fd),
    )
    .map_err(|_| "fd-exec spawn".to_string())?;
    unix_close_fds(&[result_w, ready_w]);

    // Wait for ready, then read the probe report.
    let mut ready_buf = [0u8; 1];
    let mut pollfd = libc::pollfd {
      fd: ready_r,
      events: libc::POLLIN,
      revents: 0,
    };
    let pr = unsafe { libc::poll(&mut pollfd, 1, 5000) };
    if pr <= 0 {
      let _ = unix_kill_and_wait(pid, Some(Instant::now() + HASH_CANCEL_JOIN_TIMEOUT));
      unix_close_fds(&[result_r, ready_r]);
      drop(locked);
      return Err("ready timeout".into());
    }
    let _ = unsafe { libc::read(ready_r, ready_buf.as_mut_ptr() as *mut _, 1) };
    unix_close_fds(&[ready_r]);

    let mut report = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
      let mut p = libc::pollfd {
        fd: result_r,
        events: libc::POLLIN,
        revents: 0,
      };
      let _ = unsafe { libc::poll(&mut p, 1, 100) };
      let mut chunk = [0u8; 16];
      let n = unsafe { libc::read(result_r, chunk.as_mut_ptr() as *mut _, chunk.len()) };
      if n > 0 {
        report.extend_from_slice(&chunk[..n as usize]);
      } else if n == 0 {
        break;
      }
    }
    unix_close_fds(&[result_r]);
    let _ = unix_reap_helper_after_success(pid, Some(deadline), locked);
    String::from_utf8(report).map_err(|e| e.to_string())
  }

  /// Shell/temp tests must use cross-platform tempfile and never create a reserved `NUL` path.
  #[test]
  fn shell_tests_use_tempfile_not_reserved_nul_path() {
    let dir = TempDir::new().unwrap();
    assert!(
      is_windows_reserved_device_name("NUL"),
      "NUL must be classified as reserved"
    );
    let target = dir.path().join("target-dir");
    std::fs::create_dir_all(&target).unwrap();
    let forbidden = dir.path().join("NUL");
    assert!(
      !create_dir_reparse(&target, &forbidden),
      "must not create reserved NUL path via reparse helper"
    );
    // Never write a reserved device basename into the tempfile tree.
    let ordinary = dir.path().join("ordinary-link");
    // Best-effort positive control; platform may refuse symlink creation without privilege.
    let _created = create_dir_reparse(&target, &ordinary);
    // The tempfile root itself is a real directory from the tempfile crate, not a device name.
    assert!(
      dir
        .path()
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| !is_windows_reserved_device_name(n))
        .unwrap_or(true),
      "TempDir must not use a reserved device basename"
    );
  }

  /// Worktree root must not contain a real `NUL` file. Tests must use tempfile / platform null
  /// devices (`Stdio::null`) — never shell redirects like `> NUL` that create a file on Git Bash.
  #[test]
  fn worktree_root_has_no_nul_file() {
    assert!(
      !worktree_root_has_real_nul_file(),
      "worktree root must not contain a real NUL file; use tempfile/Stdio::null, not shell > NUL"
    );
  }

  /// Detect a real file named NUL at the workspace root (not the Windows NUL device).
  /// Uses directory iteration so DOS device-name parsing cannot hide or mis-open the entry.
  fn worktree_root_has_real_nul_file() -> bool {
    // CARGO_MANIFEST_DIR is src-tauri/; worktree root is its parent.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .map(Path::to_path_buf)
      .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let Ok(entries) = std::fs::read_dir(&root) else {
      return false;
    };
    for entry in entries.flatten() {
      let name = entry.file_name();
      if name.eq_ignore_ascii_case("NUL") {
        // Confirm it is a directory entry (real file/dir), not a failed device open.
        if entry.file_type().is_ok() {
          return true;
        }
      }
    }
    false
  }

  /// Absolute-deadline cleanup must not synchronously add HASH_CANCEL_JOIN_TIMEOUT (5s) on the
  /// request path. After the deadline, kill/wait + locked image ownership transfers to a
  /// background reaper that holds them until waitpid confirms reap (never abandon into zombie).
  /// Tests wait on the PID-scoped reaper completion hook — never compete for waitpid/reap here.
  #[cfg(unix)]
  #[test]
  fn absolute_deadline_cleanup_reaps_child_without_sync_join_budget() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("linger.rs");
    let exe = dir.path().join("linger");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile linger");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn linger");
    let pid = child.id() as i32;
    // Forget the std Child so the background reaper alone owns waitpid.
    std::mem::forget(child);

    let completion = UnixReaperCompletionHook::install(pid);
    // Locked image ownership must transfer with the reaper (not dropped on the request path).
    let locked = lock_native_hash_helper_image().expect("lock image for reaper ownership");

    // Already-expired absolute deadline: cleanup must return promptly (background reaper).
    let started = Instant::now();
    let absolute = Some(Instant::now() - Duration::from_millis(1));
    unix_cleanup_helper_after_deadline(pid, absolute, locked);
    let elapsed = started.elapsed();
    assert!(
      elapsed < Duration::from_millis(500),
      "expired absolute deadline must not sync-wait join budget; elapsed={elapsed:?}"
    );

    // Wait for reaper notification after waitpid confirms — do not race waitpid from this thread.
    let notified = completion
      .recv_timeout(Duration::from_secs(5))
      .expect("background reaper must notify after waitpid confirms reap");
    assert_eq!(notified, pid, "reaper must report the helper pid");

    // Post-notify ECHILD check only (non-consuming relative to the reaper: already reaped).
    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    assert!(
      wr < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
      "after reaper notify, waitpid must return ECHILD (already reaped); got wr={wr}"
    );
  }

  /// Bounded `unix_kill_and_wait` Err must not drop LockedHelperImage on the request path.
  /// PID + locked image transfer to the background reaper; release only after waitpid confirms.
  #[cfg(unix)]
  #[test]
  fn bounded_kill_wait_err_transfers_locked_helper_to_reaper() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang_err.rs");
    let exe = dir.path().join("hang_err");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile hang_err");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn hang_err");
    let pid = child.id() as i32;
    std::mem::forget(child);

    let completion = UnixReaperCompletionHook::install(pid);
    let locked = lock_native_hash_helper_image().expect("lock image for Err-path handoff");

    // Force bounded kill+wait Err for this PID+token only. Future deadline selects the bounded path.
    // Fault is consumed by the target call; release the guard immediately after it returns.
    let force = ForceUnixKillWaitErrGuard::arm(pid);
    let absolute = Some(Instant::now() + Duration::from_secs(30));
    unix_cleanup_helper_after_deadline(pid, absolute, locked);
    drop(force);

    let notified = completion
      .recv_timeout(Duration::from_secs(5))
      .expect("bounded kill Err must hand PID+locked_helper to background reaper");
    assert_eq!(notified, pid, "reaper must report the unreaped helper pid");

    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    assert!(
      wr < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
      "reaper must confirm reap after Err handoff; got wr={wr}"
    );
  }

  /// Join-timeout-only cleanup (no absolute deadline) must also hand off on bounded kill Err.
  #[cfg(unix)]
  #[test]
  fn join_timeout_cleanup_err_transfers_locked_helper_to_reaper() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang_join.rs");
    let exe = dir.path().join("hang_join");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile hang_join");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn hang_join");
    let pid = child.id() as i32;
    std::mem::forget(child);

    let completion = UnixReaperCompletionHook::install(pid);
    let locked = lock_native_hash_helper_image().expect("lock image for join-timeout Err handoff");

    let force = ForceUnixKillWaitErrGuard::arm(pid);
    // No absolute deadline: uses named join timeout bound, then must hand off on Err.
    unix_cleanup_helper_after_deadline(pid, None, locked);
    drop(force);

    let notified = completion
      .recv_timeout(Duration::from_secs(5))
      .expect("join-timeout Err must hand PID+locked_helper to background reaper");
    assert_eq!(notified, pid);

    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    assert!(
      wr < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
      "reaper must confirm reap after join-timeout Err handoff; got wr={wr}"
    );
  }

  /// Direct probe: drop_gate blocks while the owned file wrapper is still live (identity readable
  /// from the observer probe), and the wrapper Drop emits a unique token only after the gate is
  /// released and the OFD is closed. Guards against inverted field/Drop order. No process-global
  /// raw FD + F_GETFD/fstat after release.
  #[cfg(unix)]
  #[test]
  fn locked_helper_image_drop_gate_holds_fd_open_until_release() {
    const DROP_TOKEN: OwnedFileDropToken = OwnedFileDropToken(0xD70B_0001);

    let locked = lock_native_hash_helper_image().expect("lock image for drop-gate probe");
    let image_identity = locked.identity;

    let (drop_started_tx, drop_started_rx) = std::sync::mpsc::channel();
    let (drop_release_tx, drop_release_rx) = std::sync::mpsc::channel();
    let (file_dropped_tx, file_dropped_rx) = std::sync::mpsc::channel();
    let locked = locked.with_drop_gate(drop_started_tx, drop_release_rx);
    let (locked, observer) = locked.with_owned_file_drop_observer(DROP_TOKEN, file_dropped_tx);
    observer.assert_live_with_identity(
      image_identity,
      "precondition: owned file wrapper must be live with recorded identity",
    );

    let joiner = std::thread::spawn(move || {
      drop(locked);
    });

    drop_started_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("drop gate must fire when LockedHelperImage drop begins");
    observer.assert_live_with_identity(
      image_identity,
      "owned file wrapper must remain live with readable identity while drop gate is blocked",
    );
    assert!(
      matches!(file_dropped_rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
      "owned file Drop token must not fire while drop gate is blocked"
    );

    drop_release_tx.send(()).expect("release LockedHelperImage drop gate");
    joiner.join().expect("drop thread must finish after gate release");

    let got = file_dropped_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("owned file wrapper Drop must send the unique token after gate release");
    assert_eq!(got, DROP_TOKEN, "drop token must match the installed unique value");
  }

  /// `unix_reap_helper_after_success` join-timeout path must hand PID+lock to the background
  /// reaper on bounded kill Err (shared `unix_bounded_kill_wait_or_background_reap` success caller).
  /// Lock is held until waitpid confirms; request path returns WorkerTimeout, never success.
  /// Drop gate + owned-file observer: completion notify does not fire while the wrapper is still
  /// live; after release the wrapper Drop emits the unique token, then completion is signaled.
  /// No process-global raw FD + F_GETFD/fstat after release.
  #[cfg(unix)]
  #[test]
  fn success_reap_join_timeout_err_transfers_locked_helper_to_reaper() {
    const DROP_TOKEN: OwnedFileDropToken = OwnedFileDropToken(0xD70B_0002);

    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang_success_reap.rs");
    let exe = dir.path().join("hang_success_reap");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile hang_success_reap");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn hang_success_reap");
    let pid = child.id() as i32;
    std::mem::forget(child);

    let completion = UnixReaperCompletionHook::install(pid);
    let (drop_started_tx, drop_started_rx) = std::sync::mpsc::channel();
    let (drop_release_tx, drop_release_rx) = std::sync::mpsc::channel();
    let (file_dropped_tx, file_dropped_rx) = std::sync::mpsc::channel();
    let locked = lock_native_hash_helper_image().expect("lock image for success-reap Err handoff");
    let image_identity = locked.identity;
    let locked = locked.with_drop_gate(drop_started_tx, drop_release_rx);
    let (locked, observer) = locked.with_owned_file_drop_observer(DROP_TOKEN, file_dropped_tx);

    // No absolute deadline: waits named join timeout, then bounded kill+wait. FORCE triggers Err handoff.
    // Fault is one-shot-consumed by the target call; drop the guard immediately after return.
    let force = ForceUnixKillWaitErrGuard::arm(pid);
    let result = unix_reap_helper_after_success(pid, None, locked);
    drop(force);
    assert_eq!(
      result,
      Err(NativeWorkerErrorCode::WorkerTimeout),
      "join-timeout bounded Err must surface WorkerTimeout, never success"
    );

    // Reaper: waitpid confirms → drop(LockedHelperImage) begins (gate fires, wrapper still live).
    drop_started_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("LockedHelperImage drop must begin only after reaper waitpid");
    observer.assert_live_with_identity(
      image_identity,
      "owned file wrapper must remain live with readable identity while drop gate holds post-waitpid",
    );
    assert!(
      matches!(file_dropped_rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
      "owned file Drop token must not fire while drop gate holds post-waitpid"
    );
    // Completion is sent only after drop returns — still held while the gate blocks.
    assert!(
      matches!(completion.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
      "reaper must not notify completion while LockedHelperImage is still held"
    );

    // Allow lock release; owned file drops (unique token) then reaper notifies completion.
    drop_release_tx.send(()).expect("release LockedHelperImage drop gate");
    let got = file_dropped_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("owned file wrapper Drop must send the unique token after gate release");
    assert_eq!(got, DROP_TOKEN, "drop token must match the installed unique value");
    let notified = completion
      .recv_timeout(Duration::from_secs(5))
      .expect("success-reap bounded Err must hand PID+locked_helper to background reaper");
    assert_eq!(notified, pid, "reaper must report the unreaped helper pid");

    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    assert!(
      wr < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
      "reaper must confirm reap after success-reap Err handoff; got wr={wr}"
    );
  }

  /// Expired absolute deadline on the success-reap path transfers lock to the background reaper
  /// immediately (no bounded sync kill+wait, never success after deadline).
  /// Drop gate + owned-file observer: wrapper stays live after waitpid until release; unique drop
  /// token then completion notify. No process-global raw FD + F_GETFD/fstat after release.
  #[cfg(unix)]
  #[test]
  fn success_reap_expired_deadline_holds_lock_until_reaper_notifies() {
    const DROP_TOKEN: OwnedFileDropToken = OwnedFileDropToken(0xD70B_0003);

    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang_success_deadline.rs");
    let exe = dir.path().join("hang_success_deadline");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc")
      .arg(&src)
      .arg("-o")
      .arg(&exe)
      .status()
      .unwrap();
    assert!(status.success(), "compile hang_success_deadline");
    let child = std::process::Command::new(&exe)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("spawn hang_success_deadline");
    let pid = child.id() as i32;
    std::mem::forget(child);

    let completion = UnixReaperCompletionHook::install(pid);
    let (drop_started_tx, drop_started_rx) = std::sync::mpsc::channel();
    let (drop_release_tx, drop_release_rx) = std::sync::mpsc::channel();
    let (file_dropped_tx, file_dropped_rx) = std::sync::mpsc::channel();
    let locked = lock_native_hash_helper_image().expect("lock image for expired success-reap handoff");
    let image_identity = locked.identity;
    let locked = locked.with_drop_gate(drop_started_tx, drop_release_rx);
    let (locked, observer) = locked.with_owned_file_drop_observer(DROP_TOKEN, file_dropped_tx);

    let started = Instant::now();
    let result = unix_reap_helper_after_success(pid, Some(Instant::now() - Duration::from_millis(1)), locked);
    let elapsed = started.elapsed();
    assert_eq!(result, Err(NativeWorkerErrorCode::WorkerTimeout));
    assert!(
      elapsed < Duration::from_millis(500),
      "expired absolute deadline must not sync-wait join budget; elapsed={elapsed:?}"
    );

    // Request path returned; lock ownership is in the reaper. Drop begins only after waitpid.
    drop_started_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("LockedHelperImage drop must begin only after reaper waitpid");
    observer.assert_live_with_identity(
      image_identity,
      "owned file wrapper must remain live with readable identity while drop gate holds post-waitpid",
    );
    assert!(
      matches!(file_dropped_rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
      "owned file Drop token must not fire while drop gate holds post-waitpid"
    );
    assert!(
      matches!(completion.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
      "reaper must not notify completion while LockedHelperImage is still held"
    );

    drop_release_tx.send(()).expect("release LockedHelperImage drop gate");
    let got = file_dropped_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("owned file wrapper Drop must send the unique token after gate release");
    assert_eq!(got, DROP_TOKEN, "drop token must match the installed unique value");
    let notified = completion
      .recv_timeout(Duration::from_secs(5))
      .expect("expired success-reap must notify after lock release post-waitpid");
    assert_eq!(notified, pid);

    let mut status = 0i32;
    let wr = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    assert!(
      wr < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
      "reaper must confirm reap after expired success-reap handoff; got wr={wr}"
    );
  }

  /// PID+token ABA: after same-PID re-registration, Drop of the old guard must not remove the
  /// newer token. Covers both fault arming and reaper completion hooks.
  #[cfg(unix)]
  #[test]
  fn pid_token_aba_old_drop_does_not_clear_newer_registration() {
    // Synthetic PIDs far from the live process table so parallel helper tests cannot collide.
    const FAULT_PID: libc::pid_t = 0x70FF_E001;
    const HOOK_PID: libc::pid_t = 0x70FF_E002;

    // --- ForceUnixKillWaitErrGuard ---
    let old_fault = ForceUnixKillWaitErrGuard::arm(FAULT_PID);
    let new_fault = ForceUnixKillWaitErrGuard::arm(FAULT_PID);
    drop(old_fault);
    assert!(
      take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "old fault guard Drop must leave the newer same-PID token armed"
    );
    assert!(
      !take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "newer fault token was one-shot consumed by the first take"
    );
    drop(new_fault); // entry already gone; Drop must be a no-op (token mismatch)

    // --- UnixReaperCompletionHook ---
    let old_hook = UnixReaperCompletionHook::install(HOOK_PID);
    let new_hook = UnixReaperCompletionHook::install(HOOK_PID);
    drop(old_hook);
    let tx = take_unix_reaper_completion_hook(HOOK_PID)
      .expect("old completion hook Drop must leave the newer same-PID registration");
    // New hook still owns the receiver side; send must succeed through the taken sender.
    tx.send(HOOK_PID).expect("newer hook sender must still be live");
    assert_eq!(
      new_hook.recv_timeout(Duration::from_secs(1)).expect("newer hook rx"),
      HOOK_PID
    );
    drop(new_hook); // map entry already taken; Drop must be a no-op
    assert!(
      take_unix_reaper_completion_hook(HOOK_PID).is_none(),
      "no residual completion registration after take + Drop"
    );
  }

  /// One-shot fault: consume is true once, false on the second call, and true again after re-arm.
  #[cfg(unix)]
  #[test]
  fn force_unix_kill_wait_err_fault_is_one_shot_and_rearmable() {
    const FAULT_PID: libc::pid_t = 0x70FF_E003;

    let first = ForceUnixKillWaitErrGuard::arm(FAULT_PID);
    assert!(
      take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "first consume of an armed fault must be true"
    );
    assert!(
      !take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "second consume without re-arm must be false"
    );
    drop(first); // already consumed; Drop must not resurrect or error

    let second = ForceUnixKillWaitErrGuard::arm(FAULT_PID);
    assert!(
      take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "re-arm after consume must yield true on the next take"
    );
    assert!(
      !take_force_unix_kill_and_wait_err_for(FAULT_PID),
      "re-armed fault remains one-shot"
    );
    drop(second);
  }
}
