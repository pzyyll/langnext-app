// ABOUTME: Offline CLI to verify a signed plugin release bundle and emit exact bootstrap policies.
// ABOUTME: Never reads private keys; verification uses only public roots and already signed archives.
use langnext_app_lib::services::plugin_release_bundle::{
  generate_bootstrap_policies_from_archives, verify_release_bundle,
};
use langnext_app_lib::services::vendor_trust;
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
    "verify-bundle" => cmd_verify_bundle(args),
    "generate-bootstrap-policy" => cmd_generate_bootstrap_policy(args),
    other => {
      eprintln!("error: unknown command {other}");
      print_usage();
      ExitCode::from(2)
    }
  }
}

fn print_usage() {
  eprintln!("usage:");
  eprintln!("  plugin_release_tool verify-bundle [resource-dir]");
  eprintln!("  plugin_release_tool generate-bootstrap-policy <archive.lnplugin...> --public-key-hex <hex>");
  eprintln!("  plugin_release_tool generate-bootstrap-policy <archive.lnplugin...> --public-key-file <path>");
  eprintln!("  plugin_release_tool generate-bootstrap-policy <archive.lnplugin...> --vendor-trust-file <path>");
}

fn cmd_verify_bundle(args: Vec<String>) -> ExitCode {
  if args.len() > 1 {
    eprintln!("error: unexpected arguments: {}", args.join(" "));
    return ExitCode::from(2);
  }
  let resource_dir = args
    .first()
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from("src-tauri/resources"));
  match verify_release_bundle(&resource_dir) {
    Ok(report) => {
      for package in &report.packages {
        println!(
          "ok plugin={} version={} digest={} status={}",
          package.plugin_id, package.version, package.package_digest, package.status
        );
      }
      println!("ok release-bundle packages={}", report.packages.len());
      ExitCode::SUCCESS
    }
    Err(err) => {
      eprintln!("error code={} message={}", err.code.as_str(), err.message);
      ExitCode::from(1)
    }
  }
}

fn cmd_generate_bootstrap_policy(mut args: Vec<String>) -> ExitCode {
  if args.is_empty() {
    eprintln!("error: generate-bootstrap-policy requires at least one archive and a public root");
    return ExitCode::from(2);
  }
  let mut archives = Vec::new();
  let mut public_key_hex = None;
  while !args.is_empty() {
    let token = args.remove(0);
    match token.as_str() {
      "--public-key-hex" => {
        if args.is_empty() {
          eprintln!("error: --public-key-hex requires a value");
          return ExitCode::from(2);
        }
        public_key_hex = Some(args.remove(0).trim().to_string());
      }
      "--public-key-file" => {
        if args.is_empty() {
          eprintln!("error: --public-key-file requires a path");
          return ExitCode::from(2);
        }
        let path = PathBuf::from(args.remove(0));
        match std::fs::read_to_string(&path) {
          Ok(contents) => public_key_hex = Some(contents.trim().to_string()),
          Err(err) => {
            eprintln!("error: failed to read public key file {}: {err}", path.display());
            return ExitCode::from(2);
          }
        }
      }
      "--vendor-trust-file" => {
        if args.is_empty() {
          eprintln!("error: --vendor-trust-file requires a path");
          return ExitCode::from(2);
        }
        let path = PathBuf::from(args.remove(0));
        match vendor_trust::load_vendor_public_keys_file(&path) {
          Ok(roots) if roots.len() == 1 => public_key_hex = Some(roots[0].public_key_hex.clone()),
          Ok(roots) => {
            eprintln!(
              "error: --vendor-trust-file must contain exactly one public root, found {}",
              roots.len()
            );
            return ExitCode::from(2);
          }
          Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::from(2);
          }
        }
      }
      other if other.starts_with("--") => {
        eprintln!("error: unknown flag {other}");
        return ExitCode::from(2);
      }
      other => archives.push(PathBuf::from(other)),
    }
  }
  let Some(public_key_hex) = public_key_hex else {
    eprintln!("error: public key required (--public-key-hex, --public-key-file, or --vendor-trust-file)");
    return ExitCode::from(2);
  };
  if archives.is_empty() {
    eprintln!("error: generate-bootstrap-policy requires at least one .lnplugin archive");
    return ExitCode::from(2);
  }

  match generate_bootstrap_policies_from_archives(&archives, &public_key_hex) {
    Ok(entries) => {
      for entry in &entries {
        println!(
          "ok plugin={} digest={} status=generated",
          entry.plugin_id, entry.package_digest
        );
      }
      match serde_json::to_string_pretty(&entries) {
        Ok(json) => {
          println!("{json}");
          ExitCode::SUCCESS
        }
        Err(err) => {
          eprintln!("error: failed to serialize bootstrap policy JSON: {err}");
          ExitCode::from(1)
        }
      }
    }
    Err(err) => {
      eprintln!("error code={} message={}", err.code.as_str(), err.message);
      ExitCode::from(1)
    }
  }
}
