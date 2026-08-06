// ABOUTME: Binary entry point for the Tauri desktop process.
// ABOUTME: Hides the Windows console window in release builds; hosts the native-hash helper subcommand.
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Hidden helper subcommand: identity-hash of one FD without forking the multi-threaded host.
  let args: Vec<String> = std::env::args().collect();
  if args.get(1).map(String::as_str)
    == Some(langnext_app_lib::services::native_workers::module_audit::NATIVE_HASH_HELPER_ARG)
  {
    langnext_app_lib::services::native_workers::module_audit::run_native_hash_helper(&args[1..]);
  }
  langnext_app_lib::run()
}
