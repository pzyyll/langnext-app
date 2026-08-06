// ABOUTME: Windows Job Object process-tree control for native worker children.
// ABOUTME: KILL_ON_JOB_CLOSE + suspended spawn ensure the whole tree dies with the host guard.
#![cfg(windows)]

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;

/// RAII guard that owns a Windows Job Object assigned to the worker process tree.
pub struct JobObjectGuard {
  handle: *mut c_void,
}

// Job object handles are process-local; the manager never shares the guard across threads.
unsafe impl Send for JobObjectGuard {}

impl Drop for JobObjectGuard {
  fn drop(&mut self) {
    if !self.handle.is_null() {
      unsafe {
        let _ = TerminateJobObject(self.handle, 1);
        let _ = CloseHandle(self.handle);
      }
      self.handle = ptr::null_mut();
    }
  }
}

/// Create a kill-on-close job and assign the child process to it.
///
/// The child must still be suspended (CREATE_SUSPENDED) so no descendant can escape before
/// assignment. Call [`resume_primary_thread`] only after this returns `Ok`.
pub fn attach_to_job(child_id: u32) -> Result<JobObjectGuard, String> {
  unsafe {
    let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
    if job.is_null() {
      return Err(format!("CreateJobObjectW failed: {}", GetLastError()));
    }

    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      &mut info as *mut _ as *mut c_void,
      size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
      let err = GetLastError();
      let _ = CloseHandle(job);
      return Err(format!("SetInformationJobObject failed: {err}"));
    }

    let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child_id);
    if process.is_null() {
      let err = GetLastError();
      let _ = CloseHandle(job);
      return Err(format!("OpenProcess failed for pid {child_id}: {err}"));
    }
    let assigned = AssignProcessToJobObject(job, process);
    let assign_err = GetLastError();
    let _ = CloseHandle(process);
    if assigned == 0 {
      let _ = CloseHandle(job);
      return Err(format!(
        "AssignProcessToJobObject failed for pid {child_id}: {assign_err}"
      ));
    }

    Ok(JobObjectGuard { handle: job })
  }
}

/// Resume the CREATE_SUSPENDED primary thread exactly once after successful Job Object assignment.
///
/// Uses the process-creation primary-thread handle (never PID thread enumeration). Verifies the
/// previous suspend count is exactly 1, then closes the handle. Fail-closed on any other count.
pub fn resume_primary_thread(primary_thread: std::os::windows::io::OwnedHandle) -> Result<(), String> {
  use std::os::windows::io::AsRawHandle;

  let raw = primary_thread.as_raw_handle();
  if raw.is_null() {
    return Err("invalid primary thread handle for resume".into());
  }
  // ResumeThread returns the previous suspend count. CREATE_SUSPENDED starts at 1; a single
  // successful resume transitions to 0 (running). Never drain unrelated suspend counts.
  let previous = unsafe { ResumeThread(raw) };
  // Drop closes the thread handle exactly once after the single ResumeThread call.
  drop(primary_thread);
  if previous == u32::MAX {
    return Err(format!("ResumeThread failed for primary thread: {}", unsafe {
      GetLastError()
    }));
  }
  if previous != 1 {
    return Err(format!(
      "unexpected primary-thread suspend count {previous}, expected 1 (CREATE_SUSPENDED)"
    ));
  }
  Ok(())
}

/// Explicitly terminate every process in the job (also happens on Drop).
pub fn terminate_job(guard: &JobObjectGuard) -> Result<(), String> {
  terminate_job_handle(guard.handle)
}

/// Raw job handle for deadline watchdogs that must kill the tree before run_session returns.
pub fn job_raw_handle(guard: &JobObjectGuard) -> *mut c_void {
  guard.handle
}

/// Terminate by raw job handle (safe to call from a watchdog thread).
pub fn terminate_job_handle(handle: *mut c_void) -> Result<(), String> {
  if handle.is_null() {
    return Ok(());
  }
  unsafe {
    if TerminateJobObject(handle, 1) == 0 {
      return Err(format!("TerminateJobObject failed: {}", GetLastError()));
    }
  }
  Ok(())
}

// --- Win32 bindings (kernel32) kept local to match screenshot.rs style. ---

const PROCESS_SET_QUOTA: u32 = 0x0100;
const PROCESS_TERMINATE: u32 = 0x0001;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

// Win32 layout field names must match the SDK; suppress Rust naming lint.
#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(non_snake_case)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
  PerProcessUserTimeLimit: i64,
  PerJobUserTimeLimit: i64,
  LimitFlags: u32,
  MinimumWorkingSetSize: usize,
  MaximumWorkingSetSize: usize,
  ActiveProcessLimit: u32,
  Affinity: usize,
  PriorityClass: u32,
  SchedulingClass: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(non_snake_case)]
struct IO_COUNTERS {
  ReadOperationCount: u64,
  WriteOperationCount: u64,
  OtherOperationCount: u64,
  ReadTransferCount: u64,
  WriteTransferCount: u64,
  OtherTransferCount: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(non_snake_case)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
  BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: usize,
  JobMemoryLimit: usize,
  PeakProcessMemoryUsed: usize,
  PeakJobMemoryUsed: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
  fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
  fn SetInformationJobObject(job: *mut c_void, info_class: u32, info: *mut c_void, length: u32) -> i32;
  fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
  fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
  fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
  fn ResumeThread(thread: *mut c_void) -> u32;
  fn CloseHandle(handle: *mut c_void) -> i32;
  fn GetLastError() -> u32;
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::native_workers::process::{SpawnConfig, cleanup_process_tree, spawn_exact};
  use std::process::Command;
  use std::thread;
  use std::time::{Duration, Instant};
  use tempfile::TempDir;

  fn process_alive(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn GetExitCodeProcess(process: *mut c_void, exit_code: *mut u32) -> i32;
    }

    unsafe {
      // OpenProcess can succeed for an exited process while handles remain open;
      // STILL_ACTIVE is the authoritative liveness check.
      let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid);
      if handle.is_null() {
        return false;
      }
      let mut code = 0u32;
      let ok = GetExitCodeProcess(handle, &mut code);
      let _ = CloseHandle(handle);
      ok != 0 && code == STILL_ACTIVE
    }
  }

  fn spawn_suspended_hang(dir: &std::path::Path) -> crate::services::native_workers::process::SpawnedWorker {
    let src = dir.join("child.rs");
    let exe = dir.join("child.exe");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile child");
    let model = dir.join("model");
    std::fs::create_dir_all(&model).unwrap();
    spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn suspended")
  }

  #[test]
  fn job_object_terminates_assigned_process_tree() {
    let dir = TempDir::new().unwrap();
    let mut spawned = spawn_suspended_hang(dir.path());
    let pid = spawned.child.id();
    let guard = attach_to_job(pid).expect("attach job");
    let primary = spawned.child.take_primary_thread().expect("primary thread");
    resume_primary_thread(primary).expect("resume after attach");
    terminate_job(&guard).expect("terminate job");
    // Drop also terminates; wait for OS to reap.
    drop(guard);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
      match spawned.child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if Instant::now() < deadline => {
          thread::sleep(Duration::from_millis(20));
        }
        Ok(None) => panic!("child still alive after job terminate"),
        Err(err) => panic!("try_wait failed: {err}"),
      }
    }
  }

  /// Production invariant: Job attach happens while suspended; after resume the full child tree
  /// (parent + grandchild) is contained and dies with TerminateJobObject.
  #[test]
  fn suspended_spawn_job_contains_child_tree() {
    let dir = TempDir::new().unwrap();
    let ready_path = dir.path().join("ready.pid");
    let src = dir.path().join("tree.rs");
    let exe = dir.path().join("tree.exe");
    // Bake absolute ready path into the fixture so spawn_exact (no env forwarding) still works.
    let ready_lit = ready_path.to_string_lossy().replace("\\", "\\\\");
    std::fs::write(
      &src,
      format!(
        r#"
use std::io::Write;
use std::process::{{Command, Stdio}};
fn main() {{
  let self_exe = std::env::current_exe().expect("self");
  if std::env::args().nth(1).as_deref() == Some("--grandchild") {{
    loop {{ std::thread::sleep(std::time::Duration::from_secs(30)); }}
  }}
  let child = Command::new(self_exe)
    .arg("--grandchild")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .expect("spawn grandchild");
  let mut file = std::fs::File::create(r"{ready_lit}").expect("ready file");
  writeln!(file, "{{}}", child.id()).expect("write grandchild pid");
  file.flush().expect("flush ready");
  loop {{ std::thread::sleep(std::time::Duration::from_secs(30)); }}
}}
"#
      ),
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile tree");

    let model = dir.path().join("model");
    std::fs::create_dir_all(&model).unwrap();
    let mut spawned = spawn_exact(&SpawnConfig {
      executable: exe,
      work_dir: dir.path().to_path_buf(),
      model_root: model,
      process_nonce: "nonce".into(),
      extra_args: vec![],
    })
    .expect("spawn suspended tree parent");
    let parent_pid = spawned.child.id();

    // While suspended, main has not run — no ready signal, no grandchild.
    thread::sleep(Duration::from_millis(200));
    assert!(
      !ready_path.exists(),
      "suspended parent must not spawn grandchildren before resume"
    );

    // Attach Job before any user code; then resume via retained primary-thread handle.
    let guard = attach_to_job(parent_pid).expect("attach job while suspended");
    let primary = spawned.child.take_primary_thread().expect("primary thread");
    resume_primary_thread(primary).expect("resume after job attach");

    let ready_deadline = Instant::now() + Duration::from_secs(5);
    let grandchild_pid = loop {
      if let Ok(contents) = std::fs::read_to_string(&ready_path) {
        let trimmed = contents.trim();
        if let Ok(pid) = trimmed.parse::<u32>() {
          if pid > 0 {
            break pid;
          }
        }
      }
      if Instant::now() >= ready_deadline {
        let _ = terminate_job(&guard);
        let _ = cleanup_process_tree(&mut spawned.child, || Ok(()));
        panic!("ready signal with grandchild pid not published in time");
      }
      thread::sleep(Duration::from_millis(20));
    };

    assert!(process_alive(parent_pid), "parent live before job kill");
    assert!(process_alive(grandchild_pid), "grandchild live before job kill");

    terminate_job(&guard).expect("terminate job tree");
    drop(guard);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
      match spawned.child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
        Ok(None) => panic!("parent still alive after job terminate"),
        Err(err) => panic!("try_wait failed: {err}"),
      }
    }

    let dead_deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(grandchild_pid) && Instant::now() < dead_deadline {
      thread::sleep(Duration::from_millis(20));
    }
    assert!(
      !process_alive(grandchild_pid),
      "grandchild pid {grandchild_pid} escaped Job Object"
    );
    assert!(!process_alive(parent_pid), "parent pid {parent_pid} still alive");
  }

  /// Attach/resume failure path: suspended child is killed without ever running main.
  #[test]
  fn attach_failure_kills_suspended_child_without_running_main() {
    let dir = TempDir::new().unwrap();
    let ready_name = "must-not-run.txt";
    let ready = dir.path().join(ready_name);
    let src = dir.path().join("norun.rs");
    let exe = dir.path().join("norun.exe");
    std::fs::write(
      &src,
      format!(
        r#"
fn main() {{
  std::fs::write({ready_name:?}, b"ran").expect("write");
  loop {{ std::thread::sleep(std::time::Duration::from_secs(30)); }}
}}
"#
      ),
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile norun");

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

    // Simulate fail-closed cleanup without resume (attach/resume failure path).
    let cleanup = cleanup_process_tree(&mut spawned.child, || Err("job_attach_failed: injected".into()));
    assert!(cleanup.is_err(), "attach failure cleanup must surface terminate error");
    let msg = cleanup.unwrap_err();
    assert!(msg.contains("terminate:"), "got {msg}");
    thread::sleep(Duration::from_millis(100));
    assert!(
      !ready.exists(),
      "fail-closed kill of suspended child must not let main run"
    );
  }
}
