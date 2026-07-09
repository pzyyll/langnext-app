// ABOUTME: Windows Snap Layout overlay via simulated Win+Z (and Alt to hide numbers).
// ABOUTME: Mirrors decorum's show_snap_overlay behavior for custom maximize hover.

/// Open the Windows Snap Layout flyout for the focused window.
///
/// No-op on non-Windows targets. On Windows, sends Win+Z then Alt
/// (same approach as tauri-plugin-decorum).
#[tauri::command]
pub async fn show_snap_overlay() {
	#[cfg(target_os = "windows")]
	{
		use enigo::{Enigo, Key, KeyboardControllable};
		use std::thread;
		use std::time::Duration;

		// Run on a blocking thread so we don't hold the async runtime during sleep.
		tauri::async_runtime::spawn_blocking(|| {
			let mut enigo = Enigo::new();
			enigo.key_down(Key::Meta);
			enigo.key_click(Key::Layout('z'));
			enigo.key_up(Key::Meta);

			thread::sleep(Duration::from_millis(50));

			// Hide the ugly number hotkeys overlay labels.
			enigo.key_click(Key::Alt);
		})
		.await
		.ok();
	}
}
