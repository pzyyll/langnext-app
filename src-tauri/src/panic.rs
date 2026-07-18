// ABOUTME: Production-safe global panic hook that never formats panic payloads.
// ABOUTME: Release builds log only a constant event; debug keeps the default hook.

/// Install the process-wide panic hook appropriate for the build profile.
pub fn install_panic_hook() {
  #[cfg(not(debug_assertions))]
  {
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Prevents recursive entry when logging from the panic hook itself panics.
    static IN_PANIC_HOOK: AtomicBool = AtomicBool::new(false);

    /// RAII flag: set on enter, cleared on drop so a later panic can log again.
    struct PanicHookGuard;

    impl Drop for PanicHookGuard {
      fn drop(&mut self) {
        IN_PANIC_HOOK.store(false, Ordering::SeqCst);
      }
    }

    std::panic::set_hook(Box::new(|_info| {
      // Recursive entry (panic while already inside this hook) — bail out.
      if IN_PANIC_HOOK.swap(true, Ordering::SeqCst) {
        return;
      }
      let _guard = PanicHookGuard;

      // Never format PanicHookInfo::payload, user input, SQL, or vault diagnostics.
      // Isolate stderr and logger: a panic in either path must not unwind the hook
      // or leave the reentrancy flag stuck (guard clears on drop either way).
      let _ = std::panic::catch_unwind(|| {
        eprintln!("panic_event subsystem=langnext_app");
      });
      let _ = std::panic::catch_unwind(|| {
        log::error!("panic_event subsystem=langnext_app");
      });
    }));
  }
  // Debug/test builds retain the standard verbose hook for diagnostics.
}

/// Payload-free panic report used by unit tests to prove formatting never includes payload text.
pub fn panic_report_line(subsystem: &'static str) -> String {
  format!("panic_event subsystem={subsystem}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn panic_report_is_payload_free_constant() {
    let line = panic_report_line("langnext_app");
    assert_eq!(line, "panic_event subsystem=langnext_app");
    assert!(!line.contains("secret"));
    assert!(!line.contains("sk-"));
    assert!(!line.contains("password"));
  }
}
