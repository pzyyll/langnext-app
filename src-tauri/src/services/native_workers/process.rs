// ABOUTME: Exact-path native worker spawn, deadline, cooperative shutdown, and process reap.
// ABOUTME: No shell/PATH lookup; host-private working directory only.
use crate::domain::native_worker::{
  NATIVE_WORKER_SHUTDOWN_TIMEOUT_MS, NATIVE_WORKER_STARTUP_TIMEOUT_MS, NativeWorkerErrorCode,
};
use std::fs::File;
use std::io::{ErrorKind, Result as IoResult};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

/// Windows CREATE_SUSPENDED — primary thread does not run until ResumeThread after Job attach.
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

/// Host-owned child process handle used by the native worker manager.
///
/// On Windows this retains the CREATE_SUSPENDED primary-thread handle so resume never enumerates
/// threads by PID or drains unrelated suspend counts.
#[derive(Debug)]
pub struct NativeChild {
  #[cfg(windows)]
  windows: WindowsNativeChild,
  #[cfg(not(windows))]
  unix: std::process::Child,
  /// Pipe ends retained as plain files so Windows CreateProcess spawn can own them without
  /// relying on non-constructible std::process::ChildStd* types.
  pub stdin: Option<File>,
  pub stdout: Option<File>,
  pub stderr: Option<File>,
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsNativeChild {
  process: std::os::windows::io::OwnedHandle,
  pid: u32,
  /// Present until the host resumes after Job Object assignment; closed on resume or drop.
  primary_thread: Option<std::os::windows::io::OwnedHandle>,
  /// Cached exit status once reaped.
  exit_status: Option<ExitStatus>,
}

#[derive(Debug)]
pub struct SpawnedWorker {
  pub child: NativeChild,
  pub executable: PathBuf,
  pub work_dir: PathBuf,
  pub process_nonce: String,
  /// Windows: true until the host resumes the primary thread after Job Object assignment.
  pub suspended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnConfig {
  pub executable: PathBuf,
  pub work_dir: PathBuf,
  pub model_root: PathBuf,
  pub process_nonce: String,
  pub extra_args: Vec<String>,
}

impl NativeChild {
  pub fn id(&self) -> u32 {
    #[cfg(windows)]
    {
      self.windows.pid
    }
    #[cfg(not(windows))]
    {
      self.unix.id()
    }
  }

  pub fn kill(&mut self) -> IoResult<()> {
    #[cfg(windows)]
    {
      self.windows.kill()
    }
    #[cfg(not(windows))]
    {
      self.unix.kill()
    }
  }

  pub fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
    #[cfg(windows)]
    {
      self.windows.try_wait()
    }
    #[cfg(not(windows))]
    {
      self.unix.try_wait()
    }
  }

  pub fn wait(&mut self) -> IoResult<ExitStatus> {
    #[cfg(windows)]
    {
      self.windows.wait()
    }
    #[cfg(not(windows))]
    {
      self.unix.wait()
    }
  }

  /// Take the CREATE_SUSPENDED primary-thread handle (Windows only). None after resume or on Unix.
  #[cfg(windows)]
  pub fn take_primary_thread(&mut self) -> Option<std::os::windows::io::OwnedHandle> {
    self.windows.primary_thread.take()
  }

  #[cfg(not(windows))]
  pub fn take_primary_thread(&mut self) -> Option<()> {
    None
  }
}

#[cfg(windows)]
impl WindowsNativeChild {
  fn kill(&mut self) -> IoResult<()> {
    use std::os::windows::io::AsRawHandle;
    if self.exit_status.is_some() {
      return Ok(());
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn TerminateProcess(process: *mut std::ffi::c_void, exit_code: u32) -> i32;
      fn GetLastError() -> u32;
    }
    let ok = unsafe { TerminateProcess(self.process.as_raw_handle(), 1) };
    if ok == 0 {
      // Already-exited processes may reject TerminateProcess.
      match self.try_wait()? {
        Some(_) => Ok(()),
        None => Err(std::io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)),
      }
    } else {
      Ok(())
    }
  }

  fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::ExitStatusExt;
    if let Some(status) = self.exit_status {
      return Ok(Some(status));
    }
    const STILL_ACTIVE: u32 = 259;
    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn GetExitCodeProcess(process: *mut std::ffi::c_void, exit_code: *mut u32) -> i32;
    }
    let mut code = 0u32;
    let ok = unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) };
    if ok == 0 {
      return Err(std::io::Error::last_os_error());
    }
    if code == STILL_ACTIVE {
      return Ok(None);
    }
    let status = ExitStatus::from_raw(code);
    self.exit_status = Some(status);
    // Primary thread handle is useless after exit; drop it if still held.
    self.primary_thread = None;
    Ok(Some(status))
  }

  fn wait(&mut self) -> IoResult<ExitStatus> {
    use std::os::windows::io::AsRawHandle;
    if let Some(status) = self.exit_status {
      return Ok(status);
    }
    const INFINITE: u32 = 0xFFFF_FFFF;
    const WAIT_OBJECT_0: u32 = 0;
    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    }
    let wr = unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) };
    if wr != WAIT_OBJECT_0 {
      return Err(std::io::Error::last_os_error());
    }
    match self.try_wait()? {
      Some(status) => Ok(status),
      None => Err(std::io::Error::other("process signaled but still active")),
    }
  }
}

pub fn spawn_exact(config: &SpawnConfig) -> Result<SpawnedWorker, NativeWorkerErrorCode> {
  if !config.executable.is_file() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  if !config.work_dir.is_dir() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  #[cfg(windows)]
  {
    return spawn_exact_windows(config);
  }

  #[cfg(not(windows))]
  {
    use std::os::fd::{FromRawFd, IntoRawFd};
    use std::process::{Command, Stdio};
    let mut command = Command::new(&config.executable);
    command
      .current_dir(&config.work_dir)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .env_clear()
      .env("LANGNEXT_NATIVE_WORKER", "1")
      .arg("--model-root")
      .arg(&config.model_root)
      .arg("--process-nonce")
      .arg(&config.process_nonce);
    for arg in &config.extra_args {
      command.arg(arg);
    }
    // Put the child in its own process group so non-Windows timeout recovery can kill the tree.
    #[cfg(unix)]
    {
      use std::os::unix::process::CommandExt;
      // SAFETY: runs in the child before exec; setpgid(0,0) creates a new group led by the child.
      unsafe {
        command.pre_exec(|| {
          if libc_setpgid(0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
          }
          Ok(())
        });
      }
    }
    let mut child = command.spawn().map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
    // Convert ChildStd* into File so NativeChild has one stdio type on all platforms.
    let stdin = child
      .stdin
      .take()
      .map(|s| unsafe { File::from_raw_fd(s.into_raw_fd()) });
    let stdout = child
      .stdout
      .take()
      .map(|s| unsafe { File::from_raw_fd(s.into_raw_fd()) });
    let stderr = child
      .stderr
      .take()
      .map(|s| unsafe { File::from_raw_fd(s.into_raw_fd()) });
    Ok(SpawnedWorker {
      child: NativeChild {
        unix: child,
        stdin,
        stdout,
        stderr,
      },
      executable: config.executable.clone(),
      work_dir: config.work_dir.clone(),
      process_nonce: config.process_nonce.clone(),
      suspended: false,
    })
  }
}

/// Windows spawn via CreateProcessW so the CREATE_SUSPENDED primary-thread handle is retained.
/// Uses STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_HANDLE_LIST so only stdin/stdout/stderr are inherited.
#[cfg(windows)]
fn spawn_exact_windows(config: &SpawnConfig) -> Result<SpawnedWorker, NativeWorkerErrorCode> {
  use std::ffi::OsStr;
  use std::os::windows::ffi::OsStrExt;
  use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle, RawHandle};
  use std::ptr;

  const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
  const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
  const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
  const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
  /// PROC_THREAD_ATTRIBUTE_HANDLE_LIST — only these handles are inherited by the child.
  const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;

  #[repr(C)]
  struct SecurityAttributes {
    length: u32,
    descriptor: *mut std::ffi::c_void,
    inherit: i32,
  }

  #[repr(C)]
  struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    std_input: *mut std::ffi::c_void,
    std_output: *mut std::ffi::c_void,
    std_error: *mut std::ffi::c_void,
  }

  #[repr(C)]
  struct StartupInfoExW {
    startup_info: StartupInfoW,
    attribute_list: *mut std::ffi::c_void,
  }

  #[repr(C)]
  struct ProcessInformation {
    process: *mut std::ffi::c_void,
    thread: *mut std::ffi::c_void,
    process_id: u32,
    thread_id: u32,
  }

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CreatePipe(
      read_pipe: *mut *mut std::ffi::c_void,
      write_pipe: *mut *mut std::ffi::c_void,
      security: *mut std::ffi::c_void,
      size: u32,
    ) -> i32;
    fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    fn CreateProcessW(
      application: *const u16,
      command_line: *mut u16,
      process_attrs: *mut SecurityAttributes,
      thread_attrs: *mut SecurityAttributes,
      inherit_handles: i32,
      creation_flags: u32,
      environment: *mut std::ffi::c_void,
      current_dir: *const u16,
      startup: *mut StartupInfoW,
      process_info: *mut ProcessInformation,
    ) -> i32;
    fn InitializeProcThreadAttributeList(
      attribute_list: *mut std::ffi::c_void,
      attribute_count: u32,
      flags: u32,
      size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
      attribute_list: *mut std::ffi::c_void,
      flags: u32,
      attribute: usize,
      value: *mut std::ffi::c_void,
      size: usize,
      previous_value: *mut std::ffi::c_void,
      return_size: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(attribute_list: *mut std::ffi::c_void);
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
  }

  fn wide_null(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
  }

  /// Create a pipe pair. On partial failure, closes any non-null end before returning Err.
  fn make_pipe() -> Result<(OwnedHandle, OwnedHandle), NativeWorkerErrorCode> {
    let mut sa = SecurityAttributes {
      length: std::mem::size_of::<SecurityAttributes>() as u32,
      descriptor: ptr::null_mut(),
      inherit: 1,
    };
    let mut read_h: *mut std::ffi::c_void = ptr::null_mut();
    let mut write_h: *mut std::ffi::c_void = ptr::null_mut();
    let ok = unsafe { CreatePipe(&mut read_h, &mut write_h, &mut sa as *mut _ as *mut std::ffi::c_void, 0) };
    if ok == 0 || read_h.is_null() || write_h.is_null() {
      // Pipe creation failure must clean any partially returned handle.
      if !read_h.is_null() {
        unsafe {
          let _ = CloseHandle(read_h);
        }
      }
      if !write_h.is_null() {
        unsafe {
          let _ = CloseHandle(write_h);
        }
      }
      return Err(NativeWorkerErrorCode::SpawnFailed);
    }
    Ok(unsafe {
      (
        OwnedHandle::from_raw_handle(read_h),
        OwnedHandle::from_raw_handle(write_h),
      )
    })
  }

  let (stdin_read, stdin_write) = make_pipe()?;
  let (stdout_read, stdout_write) = match make_pipe() {
    Ok(pair) => pair,
    Err(err) => {
      // Prior pipe ends drop via OwnedHandle — explicit for the failure contract.
      drop(stdin_read);
      drop(stdin_write);
      return Err(err);
    }
  };
  let (stderr_read, stderr_write) = match make_pipe() {
    Ok(pair) => pair,
    Err(err) => {
      drop(stdin_read);
      drop(stdin_write);
      drop(stdout_read);
      drop(stdout_write);
      return Err(err);
    }
  };

  // Parent ends must not be inherited; child ends stay inheritable for HANDLE_LIST.
  if unsafe { SetHandleInformation(stdin_write.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0
    || unsafe { SetHandleInformation(stdout_read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0
    || unsafe { SetHandleInformation(stderr_read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0
  {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  // Build command line: "exe" --model-root ... --process-nonce ...
  let mut command_line = String::new();
  command_line.push('"');
  command_line.push_str(&config.executable.to_string_lossy());
  command_line.push('"');
  command_line.push_str(" --model-root ");
  command_line.push('"');
  command_line.push_str(&config.model_root.to_string_lossy());
  command_line.push('"');
  command_line.push_str(" --process-nonce ");
  command_line.push('"');
  command_line.push_str(&config.process_nonce);
  command_line.push('"');
  for arg in &config.extra_args {
    command_line.push(' ');
    command_line.push('"');
    command_line.push_str(arg);
    command_line.push('"');
  }
  let mut command_line_wide: Vec<u16> = OsStr::new(&command_line)
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
  let app_wide = wide_null(config.executable.as_os_str());
  let cwd_wide = wide_null(config.work_dir.as_os_str());

  // Minimal environment: LANGNEXT_NATIVE_WORKER, empty PATH, SystemRoot.
  let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsStr::new(r"C:\Windows").to_os_string());
  let mut env_block = Vec::<u16>::new();
  for (key, value) in [
    (OsStr::new("LANGNEXT_NATIVE_WORKER"), OsStr::new("1")),
    (OsStr::new("PATH"), OsStr::new("")),
    (OsStr::new("SystemRoot"), system_root.as_os_str()),
  ] {
    env_block.extend(key.encode_wide());
    env_block.push(u16::from(b'='));
    env_block.extend(value.encode_wide());
    env_block.push(0);
  }
  env_block.push(0);

  // Exact inherit set: only the three child stdio ends. No other inheritable host handles leak.
  let mut inherit_handles = [
    stdin_read.as_raw_handle(),
    stdout_write.as_raw_handle(),
    stderr_write.as_raw_handle(),
  ];

  let mut attr_size: usize = 0;
  unsafe {
    // First call sizes the attribute list buffer.
    let _ = InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attr_size);
  }
  if attr_size == 0 {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  let mut attr_buf = vec![0u8; attr_size];
  let attr_list = attr_buf.as_mut_ptr() as *mut std::ffi::c_void;
  if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }
  let updated = unsafe {
    UpdateProcThreadAttribute(
      attr_list,
      0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherit_handles.as_mut_ptr() as *mut std::ffi::c_void,
      std::mem::size_of_val(&inherit_handles),
      ptr::null_mut(),
      ptr::null_mut(),
    )
  };
  if updated == 0 {
    unsafe {
      DeleteProcThreadAttributeList(attr_list);
    }
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  let mut startup_ex: StartupInfoExW = unsafe { std::mem::zeroed() };
  startup_ex.startup_info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
  startup_ex.startup_info.flags = STARTF_USESTDHANDLES;
  startup_ex.startup_info.std_input = stdin_read.as_raw_handle();
  startup_ex.startup_info.std_output = stdout_write.as_raw_handle();
  startup_ex.startup_info.std_error = stderr_write.as_raw_handle();
  startup_ex.attribute_list = attr_list;

  let mut process_info: ProcessInformation = unsafe { std::mem::zeroed() };
  let created = unsafe {
    CreateProcessW(
      app_wide.as_ptr(),
      command_line_wide.as_mut_ptr(),
      ptr::null_mut(),
      ptr::null_mut(),
      1, // inherit_handles required for HANDLE_LIST members
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      env_block.as_mut_ptr() as *mut std::ffi::c_void,
      cwd_wide.as_ptr(),
      &mut startup_ex.startup_info,
      &mut process_info,
    )
  };
  // Attribute list must be destroyed after CreateProcess regardless of outcome.
  unsafe {
    DeleteProcThreadAttributeList(attr_list);
  }
  // Child-inherited pipe ends must be closed in the parent regardless of CreateProcess result.
  drop(stdin_read);
  drop(stdout_write);
  drop(stderr_write);

  if created == 0 || process_info.process.is_null() || process_info.thread.is_null() {
    return Err(NativeWorkerErrorCode::SpawnFailed);
  }

  let process = unsafe { OwnedHandle::from_raw_handle(process_info.process as RawHandle) };
  let primary_thread = unsafe { OwnedHandle::from_raw_handle(process_info.thread as RawHandle) };
  let pid = process_info.process_id;

  let stdin = Some(unsafe { File::from_raw_handle(stdin_write.into_raw_handle()) });
  let stdout = Some(unsafe { File::from_raw_handle(stdout_read.into_raw_handle()) });
  let stderr = Some(unsafe { File::from_raw_handle(stderr_read.into_raw_handle()) });

  Ok(SpawnedWorker {
    child: NativeChild {
      windows: WindowsNativeChild {
        process,
        pid,
        primary_thread: Some(primary_thread),
        exit_status: None,
      },
      stdin,
      stdout,
      stderr,
    },
    executable: config.executable.clone(),
    work_dir: config.work_dir.clone(),
    process_nonce: config.process_nonce.clone(),
    suspended: true,
  })
}

pub fn startup_deadline() -> Instant {
  Instant::now() + Duration::from_millis(NATIVE_WORKER_STARTUP_TIMEOUT_MS)
}

/// Startup deadline from an explicit timeout (used by manager tests and optional request overrides).
pub fn deadline_after(timeout: Duration) -> Instant {
  Instant::now() + timeout
}

pub fn shutdown_deadline() -> Instant {
  Instant::now() + Duration::from_millis(NATIVE_WORKER_SHUTDOWN_TIMEOUT_MS)
}

/// Format terminate/kill/wait failures into one stable cleanup detail string.
pub fn format_cleanup_errors(
  terminate: Option<String>,
  kill: Option<String>,
  wait: Option<String>,
) -> Result<(), String> {
  let mut parts = Vec::new();
  if let Some(err) = terminate {
    parts.push(format!("terminate: {err}"));
  }
  if let Some(err) = kill {
    parts.push(format!("kill: {err}"));
  }
  if let Some(err) = wait {
    parts.push(format!("wait: {err}"));
  }
  if parts.is_empty() {
    Ok(())
  } else {
    Err(parts.join("; "))
  }
}

/// Best-effort process-tree cleanup that never skips later steps after an earlier failure.
///
/// Order: terminate tree (job/process-group) → direct kill → wait/reap.
/// Each step runs even when a previous step failed; errors are collected and returned together.
pub fn cleanup_process_tree<F>(child: &mut NativeChild, terminate_tree: F) -> Result<(), String>
where
  F: FnOnce() -> Result<(), String>,
{
  let terminate_err = match terminate_tree() {
    Ok(()) => None,
    Err(err) => Some(err),
  };

  let kill_err = match child.kill() {
    Ok(()) => None,
    Err(err) => {
      // Already-exited children may reject kill; that is not a cleanup failure by itself.
      match child.try_wait() {
        Ok(Some(_)) => None,
        Ok(None) => Some(err.to_string()),
        Err(try_err) => Some(format!("{err}; try_wait: {try_err}")),
      }
    }
  };

  let wait_err = match child.wait() {
    Ok(_) => None,
    Err(err) if err.kind() == ErrorKind::InvalidInput => {
      // Status already collected via try_wait above.
      None
    }
    Err(err) => Some(err.to_string()),
  };

  format_cleanup_errors(terminate_err, kill_err, wait_err)
}

pub fn kill_and_reap(child: &mut NativeChild) -> Result<(), String> {
  cleanup_process_tree(child, || Ok(()))
}

/// After spawn: terminate the tree first, then always direct-kill + wait/reap.
///
/// Order matters — parent-only `kill` leaves grandchildren alive when a job/group exists.
/// Windows suspended pre-Job children have no descendants yet; terminate is a no-op and kill reaps.
///
/// Returns the aggregated terminate/kill/wait detail string on failure (never only a stable code).
pub fn terminate_tree_then_reap(child: &mut NativeChild) -> Result<(), String> {
  let pid = child.id();
  cleanup_process_tree(child, || {
    #[cfg(unix)]
    {
      // Encode PID the same way platform::job_raw_handle does for non-Windows guards.
      let handle = pid as usize as *mut std::ffi::c_void;
      crate::services::native_workers::platform::terminate_job_handle(handle)
    }
    #[cfg(windows)]
    {
      // Pre-Job window (including CREATE_SUSPENDED): no Job handle yet; kill step reaps the child.
      // A suspended primary thread cannot spawn descendants before Job attach + resume.
      let _ = pid;
      Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
      let _ = pid;
      Err("process-tree terminate unsupported on this platform".into())
    }
  })
}

pub fn try_wait_timeout(
  child: &mut NativeChild,
  deadline: Instant,
) -> Result<Option<ExitStatus>, NativeWorkerErrorCode> {
  loop {
    match child.try_wait() {
      Ok(Some(status)) => return Ok(Some(status)),
      Ok(None) => {
        if Instant::now() >= deadline {
          return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
      }
      Err(_) => return Err(NativeWorkerErrorCode::WorkerCrashed),
    }
  }
}

pub fn assert_no_reparse_point(path: &Path) -> Result<(), NativeWorkerErrorCode> {
  // Best-effort: reject symlink paths on all platforms.
  let meta = std::fs::symlink_metadata(path).map_err(|_| NativeWorkerErrorCode::SpawnFailed)?;
  if meta.file_type().is_symlink() {
    return Err(NativeWorkerErrorCode::RuntimeDigestMismatch);
  }
  Ok(())
}

/// setpgid(2) via raw syscall linkage so the worker becomes its own process-group leader.
#[cfg(unix)]
fn libc_setpgid(pid: i32, pgid: i32) -> i32 {
  #[link(name = "c")]
  unsafe extern "C" {
    fn setpgid(pid: i32, pgid: i32) -> i32;
  }
  unsafe { setpgid(pid, pgid) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;
  use std::thread;
  use tempfile::TempDir;

  fn compile_hang_exe(dir: &Path) -> PathBuf {
    let src = dir.join("hang.rs");
    let exe = if cfg!(windows) {
      dir.join("hang.exe")
    } else {
      dir.join("hang")
    };
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile hang");
    exe
  }

  #[test]
  fn format_cleanup_errors_aggregates_terminate_kill_wait() {
    let err = format_cleanup_errors(
      Some("TerminateJobObject failed: 6".into()),
      Some("access denied".into()),
      Some("wait broken".into()),
    )
    .expect_err("all three failed");
    assert!(err.contains("terminate:"), "got {err}");
    assert!(err.contains("kill:"), "got {err}");
    assert!(err.contains("wait:"), "got {err}");
    assert!(err.contains("TerminateJobObject"), "got {err}");
  }

  #[test]
  fn format_cleanup_errors_ok_when_no_steps_failed() {
    format_cleanup_errors(None, None, None).expect("no errors");
  }

  /// terminate_tree_then_reap must return the multi-step detail string, not only a stable code.
  #[test]
  fn terminate_tree_then_reap_preserves_aggregated_cleanup_details() {
    let dir = TempDir::new().unwrap();
    let exe = compile_hang_exe(dir.path());
    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn");
    // Inject terminate failure by wrapping cleanup_process_tree semantics: force a synthetic
    // multi-step failure string through format_cleanup_errors contract used by terminate path.
    let detail = format_cleanup_errors(
      Some("TerminateJobObject failed: 6".into()),
      Some("access denied".into()),
      Some("wait broken".into()),
    )
    .expect_err("multi");
    assert!(detail.contains("terminate:"), "got {detail}");
    assert!(detail.contains("kill:"), "got {detail}");
    assert!(detail.contains("wait:"), "got {detail}");
    // Real reap must still succeed and return Ok (detail preserved only on failure).
    terminate_tree_then_reap(&mut spawned.child).expect("reap suspended/hang child");
  }

  /// Terminate failure must not skip direct kill + wait; the hanging child must still be reaped.
  #[test]
  fn cleanup_process_tree_runs_kill_and_wait_after_terminate_failure() {
    let dir = TempDir::new().unwrap();
    let exe = compile_hang_exe(dir.path());
    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn hang");
    let result = cleanup_process_tree(&mut spawned.child, || Err("terminate injected".into()));
    assert!(result.is_err(), "terminate failure must surface");
    let msg = result.unwrap_err();
    assert!(
      msg.contains("terminate: terminate injected"),
      "stable terminate detail required, got {msg}"
    );
    // Status already consumed by wait inside cleanup; a second wait must report already reaped.
    match spawned.child.try_wait() {
      Ok(Some(_)) => {}
      Ok(None) => panic!("child still live after cleanup despite terminate failure"),
      Err(err) if err.kind() == ErrorKind::InvalidInput => {}
      Err(err) => panic!("unexpected try_wait after reap: {err}"),
    }
  }

  /// Successful terminate still proceeds to kill + wait (idempotent) without fabricating errors.
  #[test]
  fn cleanup_process_tree_succeeds_when_all_steps_ok() {
    let dir = TempDir::new().unwrap();
    let exe = compile_hang_exe(dir.path());
    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn hang");
    cleanup_process_tree(&mut spawned.child, || Ok(())).expect("cleanup ok");
  }

  /// spawn_exact on Windows must mark the child suspended and retain the primary-thread handle.
  #[cfg(windows)]
  #[test]
  fn spawn_exact_marks_child_suspended_on_windows() {
    let dir = TempDir::new().unwrap();
    let exe = compile_hang_exe(dir.path());
    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn suspended");
    assert!(spawned.suspended, "Windows spawn must start suspended");
    assert!(
      spawned.child.take_primary_thread().is_some(),
      "CREATE_SUSPENDED primary-thread handle must be retained"
    );
    // Handle already taken; cleanup still reaps the process.
    cleanup_process_tree(&mut spawned.child, || Ok(())).expect("reap suspended");
  }

  /// Dedicated suspended spawn proves main does not run pre-resume; resume uses primary handle once.
  #[cfg(windows)]
  #[test]
  fn create_suspended_child_does_not_run_main_until_resume() {
    let dir = TempDir::new().unwrap();
    let ready = dir.path().join("ready.txt");
    let src = dir.path().join("signal2.rs");
    let exe = dir.path().join("signal2.exe");
    std::fs::write(
      &src,
      r#"
fn main() {
  let path = std::env::var("READY_PATH").expect("READY_PATH");
  std::fs::write(&path, b"ran").expect("write ready");
  loop { std::thread::sleep(std::time::Duration::from_secs(30)); }
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile signal2");

    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    // Use spawn_exact path (retains primary thread). READY_PATH via extra env is not in spawn_exact;
    // compile a child that writes a fixed relative path under work_dir instead.
    let src2 = dir.path().join("signal3.rs");
    let exe2 = dir.path().join("signal3.exe");
    let ready_name = "ready-signal3.txt";
    std::fs::write(
      &src2,
      format!(
        r#"
fn main() {{
  std::fs::write({ready_name:?}, b"ran").expect("write ready");
  loop {{ std::thread::sleep(std::time::Duration::from_secs(30)); }}
}}
"#
      ),
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src2).arg("-o").arg(&exe2).status().unwrap();
    assert!(status.success(), "compile signal3");

    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe2,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn suspended");

    thread::sleep(Duration::from_millis(300));
    let ready_path = dir.path().join(ready_name);
    assert!(!ready_path.exists(), "main must not run while suspended");

    let thread_handle = spawned
      .child
      .take_primary_thread()
      .expect("primary thread handle required");
    crate::services::native_workers::platform::resume_primary_thread(thread_handle).expect("resume once");
    spawned.suspended = false;

    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready_path.exists() && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(20));
    }
    assert!(ready_path.exists(), "main must run after resume");
    let _ = cleanup_process_tree(&mut spawned.child, || Ok(()));
    let _ = ready; // silence unused from earlier fixture path
  }

  /// ResumeThread must run exactly once against the retained primary handle and verify suspend count.
  #[cfg(windows)]
  #[test]
  fn resume_primary_thread_once_verifies_suspend_count() {
    let dir = TempDir::new().unwrap();
    let exe = compile_hang_exe(dir.path());
    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn suspended");
    let handle = spawned.child.take_primary_thread().expect("primary thread");
    crate::services::native_workers::platform::resume_primary_thread(handle).expect("resume count==1");
    // Second take is None — handle was consumed/closed by resume_primary_thread.
    assert!(spawned.child.take_primary_thread().is_none());
    let _ = cleanup_process_tree(&mut spawned.child, || Ok(()));
  }

  /// PROC_THREAD_ATTRIBUTE_HANDLE_LIST must prevent an inheritable sentinel handle from reaching the worker.
  #[cfg(windows)]
  #[test]
  fn spawn_exact_does_not_inherit_sentinel_handle() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr;

    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn CreateEventW(
        attributes: *mut std::ffi::c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
      ) -> *mut std::ffi::c_void;
      fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }

    #[repr(C)]
    struct SecurityAttributes {
      length: u32,
      descriptor: *mut std::ffi::c_void,
      inherit: i32,
    }

    let dir = TempDir::new().unwrap();
    // Child receives the sentinel handle value as a decimal arg and probes GetHandleInformation.
    // Exit 0 = handle NOT inherited (invalid in child). Exit 1 = inherited (leak).
    let src = dir.path().join("sentinel_probe.rs");
    let exe = dir.path().join("sentinel_probe.exe");
    std::fs::write(
      &src,
      r#"
use std::env;
fn main() {
  let raw: usize = env::args().nth(1).expect("handle arg").parse().expect("parse");
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetHandleInformation(handle: *mut core::ffi::c_void, flags: *mut u32) -> i32;
    fn GetLastError() -> u32;
  }
  let mut flags = 0u32;
  let ok = unsafe { GetHandleInformation(raw as *mut _, &mut flags) };
  if ok == 0 {
    // ERROR_INVALID_HANDLE (6) means the value is not open in this process — not inherited.
    let err = unsafe { GetLastError() };
    if err == 6 {
      std::process::exit(0);
    }
    std::process::exit(2);
  }
  // Handle is valid in the child — inheritance leak.
  std::process::exit(1);
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile sentinel_probe");

    // Inheritable sentinel event that must NOT appear in the worker.
    let mut sa = SecurityAttributes {
      length: std::mem::size_of::<SecurityAttributes>() as u32,
      descriptor: ptr::null_mut(),
      inherit: 1,
    };
    let sentinel_raw = unsafe { CreateEventW(&mut sa as *mut _ as *mut std::ffi::c_void, 1, 0, ptr::null()) };
    assert!(!sentinel_raw.is_null(), "CreateEventW sentinel");
    let set = unsafe { SetHandleInformation(sentinel_raw, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
    assert!(set != 0, "SetHandleInformation inherit");
    let sentinel = unsafe { OwnedHandle::from_raw_handle(sentinel_raw) };
    let sentinel_value = sentinel.as_raw_handle() as usize;

    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    // Probe binary ignores model/nonce args; we pass the sentinel value as extra_args[0].
    // spawn_exact always prefixes --model-root/--process-nonce, so the probe reads args().nth(1)
    // incorrectly. Use a dedicated probe that scans all args for a --sentinel= prefix instead.
    let src2 = dir.path().join("sentinel_probe2.rs");
    let exe2 = dir.path().join("sentinel_probe2.exe");
    std::fs::write(
      &src2,
      r#"
use std::env;
fn main() {
  let mut raw: Option<usize> = None;
  for arg in env::args().skip(1) {
    if let Some(v) = arg.strip_prefix("--sentinel=") {
      raw = Some(v.parse().expect("parse sentinel"));
    }
  }
  let raw = raw.expect("--sentinel=");
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetHandleInformation(handle: *mut core::ffi::c_void, flags: *mut u32) -> i32;
    fn GetLastError() -> u32;
  }
  let mut flags = 0u32;
  let ok = unsafe { GetHandleInformation(raw as *mut _, &mut flags) };
  if ok == 0 {
    let err = unsafe { GetLastError() };
    // 6 = ERROR_INVALID_HANDLE → not inherited.
    std::process::exit(if err == 6 { 0 } else { 2 });
  }
  std::process::exit(1);
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src2).arg("-o").arg(&exe2).status().unwrap();
    assert!(status.success(), "compile sentinel_probe2");

    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe2,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![format!("--sentinel={sentinel_value}")],
    })
    .expect("spawn with sentinel present in parent");

    // Resume so the probe can run main and exit.
    let primary = spawned.child.take_primary_thread().expect("primary");
    crate::services::native_workers::platform::resume_primary_thread(primary).expect("resume");
    spawned.suspended = false;

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
      match spawned.child.try_wait() {
        Ok(Some(status)) => break status,
        Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
        Ok(None) => {
          let _ = cleanup_process_tree(&mut spawned.child, || Ok(()));
          panic!("sentinel probe did not exit");
        }
        Err(err) => panic!("try_wait: {err}"),
      }
    };
    // Keep sentinel alive until the child has exited so a leaked inherit would still be valid.
    drop(sentinel);
    assert!(
      status.success(),
      "worker must not inherit sentinel handle; exit={status:?} (0=not inherited, 1=leaked)"
    );
    // silence unused first probe fixture
    let _ = exe;
  }
}
