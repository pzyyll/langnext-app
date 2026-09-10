// ABOUTME: Offline CLI for structurally validating plugin directories/archives and packing them.
// ABOUTME: No signing, publisher, or release-verification commands exist.
use langnext_app_lib::domain::plugin_catalog::PluginSource;
use langnext_app_lib::services::plugin_loader::{PluginLoader, pack_directory_to_archive};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
  let mut args = env::args().skip(1).collect::<Vec<_>>();
  if args.is_empty() {
    print_usage();
    return ExitCode::from(2);
  }
  let cmd = args.remove(0);
  match cmd.as_str() {
    "verify-structure" => cmd_verify_structure(args),
    "pack" => cmd_pack(args),
    other => {
      eprintln!("error: unknown command {other}");
      print_usage();
      ExitCode::from(2)
    }
  }
}

fn print_usage() {
  eprintln!("usage:");
  eprintln!("  plugin_tool verify-structure <plugin-dir|package.lnplugin> [more...]");
  eprintln!("  plugin_tool pack <plugin-dir> <output.lnplugin>");
}

/// Validate plugin directories and archives structurally and print their content identity.
///
/// Source-based validation: manifest, indexed files, path safety, size bounds, and the
/// canonical content digest. No plugin-level trust artifact is required or checked.
fn cmd_verify_structure(args: Vec<String>) -> ExitCode {
  if args.is_empty() {
    eprintln!("error: missing plugin directory or archive path");
    return ExitCode::from(2);
  }
  let cache = env::temp_dir().join("langnext-plugin-structure-cache");
  let loader = PluginLoader::new(cache);
  let mut failures = 0usize;
  for raw in &args {
    let path = PathBuf::from(raw);
    let loaded = if path.is_dir() {
      loader.load_directory(PluginSource::BuiltIn, &path)
    } else {
      loader.load_archive(PluginSource::BuiltIn, &path)
    };
    match loaded {
      Ok(loaded) => {
        println!("ok path={raw}");
        println!("plugin={}@{}", loaded.descriptor.plugin_id, loaded.descriptor.version);
        println!("digest={}", loaded.descriptor.content_digest);
        println!("runtime={:?}", loaded.descriptor.runtime_kind);
        println!("files={}", loaded.descriptor.file_count);
      }
      Err(err) => {
        failures += 1;
        eprintln!("error path={raw} code={} message={}", err.code.as_str(), err.message);
      }
    }
  }
  if failures > 0 {
    eprintln!(
      "error: {failures} of {} inputs failed structural validation",
      args.len()
    );
    return ExitCode::from(1);
  }
  ExitCode::SUCCESS
}

/// Pack one validated directory into a deterministic unsigned archive.
fn cmd_pack(mut args: Vec<String>) -> ExitCode {
  if args.len() != 2 {
    eprintln!("error: pack requires <plugin-dir> <output.lnplugin>");
    return ExitCode::from(2);
  }
  let output = PathBuf::from(args.pop().expect("output path"));
  let input = PathBuf::from(args.pop().expect("input path"));
  match pack_directory_to_archive(&input, &output) {
    Ok(digest) => {
      println!("packed={}", output.display());
      println!("digest={digest}");
      ExitCode::SUCCESS
    }
    Err(err) => {
      eprintln!("error code={} message={}", err.code.as_str(), err.message);
      ExitCode::from(1)
    }
  }
}
