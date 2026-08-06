// ABOUTME: Dedicated exec-only helper that SHA-256-hashes one FD for native-worker identity audit.
// ABOUTME: FD-exec'd (execveat/fexecve) with fixed FDs; never runs Rust hash work in a fork child.
use langnext_app_lib::services::native_workers::module_audit::{NATIVE_HASH_HELPER_ARG, run_native_hash_helper};

fn main() {
  let args: Vec<String> = std::env::args().collect();
  // Accept bare invocation and the hidden subcommand form used by the desktop binary.
  let rest = if args.get(1).map(String::as_str) == Some(NATIVE_HASH_HELPER_ARG) {
    args[1..].to_vec()
  } else {
    args[1..].to_vec()
  };
  run_native_hash_helper(&rest);
}
