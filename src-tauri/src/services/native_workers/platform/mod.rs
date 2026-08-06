// ABOUTME: Platform process-tree control for native workers.
// ABOUTME: Windows uses Job Objects; other platforms use process-group / PID kill fallback.
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{
  JobObjectGuard, attach_to_job, job_raw_handle, resume_primary_thread, terminate_job, terminate_job_handle,
};

/// Non-Windows process-tree guard: retains the child PID (and process-group id when available).
#[cfg(not(windows))]
#[derive(Debug)]
pub struct JobObjectGuard {
  pid: u32,
}

#[cfg(not(windows))]
pub fn attach_to_job(child_id: u32) -> Result<JobObjectGuard, String> {
  if child_id == 0 {
    return Err("invalid child pid".into());
  }
  Ok(JobObjectGuard { pid: child_id })
}

/// Non-Windows: processes are not created suspended; resume is a no-op.
#[cfg(not(windows))]
pub fn resume_primary_thread(_token: ()) -> Result<(), String> {
  Ok(())
}

#[cfg(not(windows))]
pub fn terminate_job(guard: &JobObjectGuard) -> Result<(), String> {
  terminate_job_handle(job_raw_handle(guard))
}

#[cfg(not(windows))]
pub fn job_raw_handle(guard: &JobObjectGuard) -> *mut std::ffi::c_void {
  // Encode PID in the pointer-sized value so watchdogs can kill without the guard.
  guard.pid as usize as *mut std::ffi::c_void
}

#[cfg(not(windows))]
pub fn terminate_job_handle(handle: *mut std::ffi::c_void) -> Result<(), String> {
  let pid = handle as usize as u32;
  if pid == 0 {
    return Ok(());
  }
  kill_process_tree(pid)
}

/// Process-group kill so a blocking pipe reader unblocks and grandchildren die with the parent.
/// Uses `libc::kill` directly — never shells out to a PATH `kill` binary.
///
/// Fail-closed: a parent-only PID kill is **not** reported as success. If the process-group
/// signal fails, callers must treat the tree as unreaped rather than assuming isolation held.
#[cfg(not(windows))]
fn kill_process_tree(pid: u32) -> Result<(), String> {
  #[cfg(unix)]
  {
    if pid == 0 || pid > i32::MAX as u32 {
      return Err(format!("invalid pid {pid}"));
    }
    let pid_i = pid as i32;
    // Negative pgid targets the process group established at spawn (setpgid).
    let pgid_rc = unsafe { libc::kill(-pid_i, libc::SIGKILL) };
    if pgid_rc == 0 {
      return Ok(());
    }
    let pgid_err = std::io::Error::last_os_error();
    // Parent-only fallback unblocks the host pipe but does NOT prove the tree is gone.
    // Never return Ok here: a surviving grandchild would be a silent process leak.
    let pid_rc = unsafe { libc::kill(pid_i, libc::SIGKILL) };
    if pid_rc == 0 {
      return Err(format!(
        "process-group kill failed for pid {pid} ({pgid_err}); parent-only kill is not tree success"
      ));
    }
    Err(format!(
      "libc::kill pgid/pid {pid} failed: pgid={pgid_err}, pid={}",
      std::io::Error::last_os_error()
    ))
  }
  #[cfg(not(unix))]
  {
    // Last-resort platform without process groups: nothing else we can do.
    let _ = pid;
    Err("process-tree kill unsupported on this platform".into())
  }
}

#[cfg(all(test, not(windows)))]
mod tests {
  use super::*;
  use std::process::{Command, Stdio};
  use std::thread;
  use std::time::Duration;
  use tempfile::TempDir;

  #[cfg(unix)]
  fn spawn_in_own_process_group(exe: &std::path::Path) -> std::process::Child {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(exe);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: runs in the child before exec; setpgid(0,0) creates a new group led by the child.
    unsafe {
      command.pre_exec(|| {
        if libc::setpgid(0, 0) != 0 {
          return Err(std::io::Error::last_os_error());
        }
        Ok(())
      });
    }
    command.spawn().expect("spawn in own process group")
  }

  #[test]
  fn process_group_kill_terminates_hanging_child() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("hang.rs");
    let exe = dir.path().join("hang");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile hang child");

    let mut child = spawn_in_own_process_group(&exe);
    let pid = child.id();
    let guard = attach_to_job(pid).expect("attach");
    terminate_job(&guard).expect("terminate");
    drop(guard);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if std::time::Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
        Ok(None) => panic!("child still alive after process-group kill"),
        Err(err) => panic!("try_wait failed: {err}"),
      }
    }
  }

  /// Independent process group + grandchild must both die under `kill(-pgid, SIGKILL)`.
  /// Fixture publishes a ready signal with the grandchild PID so the test never races spawn.
  #[test]
  fn process_group_kill_reaps_grandchild_in_same_group() {
    let dir = TempDir::new().unwrap();
    let ready_path = dir.path().join("ready.pid");
    let src = dir.path().join("tree.rs");
    let exe = dir.path().join("tree");
    // Parent forks a grandchild hang, writes "<grandchild_pid>\n" to READY_PATH, then hangs.
    // Both stay in the same process group (no setpgid in the grandchild).
    std::fs::write(
      &src,
      r#"
use std::io::Write;
use std::process::{Command, Stdio};
fn main() {
  let self_exe = std::env::current_exe().expect("self");
  if std::env::args().nth(1).as_deref() == Some("--grandchild") {
    loop { std::thread::sleep(std::time::Duration::from_secs(30)); }
  }
  let child = Command::new(self_exe)
    .arg("--grandchild")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .expect("spawn grandchild");
  let ready = std::env::var("READY_PATH").expect("READY_PATH");
  let mut file = std::fs::File::create(&ready).expect("ready file");
  writeln!(file, "{}", child.id()).expect("write grandchild pid");
  file.flush().expect("flush ready");
  loop { std::thread::sleep(std::time::Duration::from_secs(30)); }
}
"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile tree");

    let mut child = {
      use std::os::unix::process::CommandExt;
      let mut command = Command::new(&exe);
      command
        .env("READY_PATH", &ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
      unsafe {
        command.pre_exec(|| {
          if libc::setpgid(0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
          }
          Ok(())
        });
      }
      command.spawn().expect("spawn tree parent")
    };
    let parent_pid = child.id();

    // Wait for the ready signal so we know the grandchild exists before killing.
    let ready_deadline = std::time::Instant::now() + Duration::from_secs(5);
    let grandchild_pid = loop {
      if let Ok(contents) = std::fs::read_to_string(&ready_path) {
        let trimmed = contents.trim();
        if let Ok(pid) = trimmed.parse::<u32>() {
          if pid > 0 {
            break pid;
          }
        }
      }
      if std::time::Instant::now() >= ready_deadline {
        let _ = child.kill();
        panic!("ready signal with grandchild pid not published in time");
      }
      thread::sleep(Duration::from_millis(20));
    };

    // Prove both PIDs are live before the kill (not a vacuous assertion).
    assert_process_alive(parent_pid, "parent before kill");
    assert_process_alive(grandchild_pid, "grandchild before kill");

    let guard = attach_to_job(parent_pid).expect("attach");
    terminate_job(&guard).expect("terminate group");
    drop(guard);

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if std::time::Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
        Ok(None) => panic!("parent still alive after process-group kill"),
        Err(err) => panic!("try_wait failed: {err}"),
      }
    }

    // Parent and grandchild must both be reaped; process-group probe must be empty.
    assert_process_dead(parent_pid, "parent after kill");
    assert_process_dead(grandchild_pid, "grandchild after kill");
    let still_alive = unsafe { libc::kill(-(parent_pid as i32), 0) } == 0;
    assert!(
      !still_alive,
      "process group {parent_pid} still has live members after SIGKILL"
    );
  }

  /// Parent-only kill success must not be reported as process-tree success.
  #[test]
  fn process_group_kill_parent_only_fallback_is_not_ok() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("solo.rs");
    let exe = dir.path().join("solo");
    std::fs::write(
      &src,
      r#"fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(30)); } }"#,
    )
    .unwrap();
    let status = Command::new("rustc").arg(&src).arg("-o").arg(&exe).status().unwrap();
    assert!(status.success(), "compile solo");

    // Spawn WITHOUT setpgid: pid is not a process-group id, so kill(-pid) fails while kill(pid)
    // succeeds. Tree kill must still return Err — parent-only is not tree success.
    let mut child = Command::new(&exe)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("spawn solo");
    let pid = child.id();
    let result = kill_process_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    assert!(
      result.is_err(),
      "process-group failure must not report Ok via parent-only kill; got {result:?}"
    );
    let msg = result.unwrap_err();
    assert!(
      msg.contains("parent-only") || msg.contains("process-group"),
      "error must describe non-tree outcome, got {msg}"
    );
  }

  fn assert_process_alive(pid: u32, label: &str) {
    let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
    assert!(alive, "{label} pid {pid} must be alive");
  }

  fn assert_process_dead(pid: u32, label: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
      let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
      if !alive {
        return;
      }
      if std::time::Instant::now() >= deadline {
        panic!("{label} pid {pid} still alive after process-group kill");
      }
      thread::sleep(Duration::from_millis(20));
    }
  }
}
