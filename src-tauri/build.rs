// ABOUTME: Cargo build script that runs Tauri's code generation hooks.
// ABOUTME: Required by tauri-build during compile time.
fn main() {
  tauri_build::build()
}
