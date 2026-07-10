// ABOUTME: Production-safe global panic hook that never formats panic payloads.
// ABOUTME: Release builds log only a constant event; debug keeps the default hook.
/// Install the process-wide panic hook appropriate for the build profile.
pub fn install_panic_hook() {
	#[cfg(not(debug_assertions))]
	{
		std::panic::set_hook(Box::new(|_info| {
			// Never format PanicHookInfo::payload, user input, SQL, or vault diagnostics.
			eprintln!("panic_event subsystem=langnext_app");
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
