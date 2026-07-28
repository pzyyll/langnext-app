// ABOUTME: Offline CLI for finalizing and verifying signed `.lnplugin` packages.
// ABOUTME: Never reads private keys; finalize revalidates an externally signed staging tree with a trusted public key.
use langnext_app_lib::services::plugin_package::{finalize_package_from_staging, verify_package_file};
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
    "verify" => cmd_verify(args),
    "finalize-package" => cmd_finalize(args),
    other => {
      eprintln!("error: unknown command {other}");
      print_usage();
      ExitCode::from(2)
    }
  }
}

fn print_usage() {
  eprintln!("usage:");
  eprintln!("  plugin_tool verify <package.lnplugin> --public-key-hex <hex>");
  eprintln!("  plugin_tool verify <package.lnplugin> --public-key-file <path>");
  eprintln!("  plugin_tool finalize-package <staging-dir> <output.lnplugin> --public-key-hex <hex>");
  eprintln!("  plugin_tool finalize-package <staging-dir> <output.lnplugin> --public-key-file <path>");
}

fn cmd_verify(mut args: Vec<String>) -> ExitCode {
  if args.is_empty() {
    eprintln!("error: missing package path");
    return ExitCode::from(2);
  }
  let path = PathBuf::from(args.remove(0));
  let public_key_hex = match take_public_key(&mut args) {
    Ok(key) => key,
    Err(code) => return code,
  };
  if !args.is_empty() {
    eprintln!("error: unexpected arguments: {}", args.join(" "));
    return ExitCode::from(2);
  }
  match verify_package_file(&path, &public_key_hex) {
    Ok(verified) => {
      println!("ok digest={}", verified.package_digest);
      println!("plugin={}@{}", verified.manifest.id, verified.manifest.version);
      println!("publisher={}", verified.manifest.publisher.key_id);
      println!("fingerprint={}", verified.publisher_fingerprint);
      ExitCode::SUCCESS
    }
    Err(err) => {
      eprintln!("error code={} message={}", err.code.as_str(), err.message);
      ExitCode::from(1)
    }
  }
}

fn cmd_finalize(mut args: Vec<String>) -> ExitCode {
  if args.len() < 2 {
    eprintln!("error: finalize-package requires <staging-dir> <output.lnplugin> and a public key");
    return ExitCode::from(2);
  }
  let staging = PathBuf::from(args.remove(0));
  let output = PathBuf::from(args.remove(0));
  let public_key_hex = match take_public_key(&mut args) {
    Ok(key) => key,
    Err(code) => return code,
  };
  if !args.is_empty() {
    eprintln!("error: unexpected arguments: {}", args.join(" "));
    return ExitCode::from(2);
  }
  match finalize_package_from_staging(&staging, &output, &public_key_hex) {
    Ok(digest) => {
      println!("ok digest={digest}");
      println!("archive={}", output.display());
      println!("sha256_file={}.sha256", output.display());
      ExitCode::SUCCESS
    }
    Err(err) => {
      eprintln!("error code={} message={}", err.code.as_str(), err.message);
      ExitCode::from(1)
    }
  }
}

fn take_public_key(args: &mut Vec<String>) -> Result<String, ExitCode> {
  if args.is_empty() {
    eprintln!(
      "error: public key required (--public-key-hex or --public-key-file); refuse to verify without trust root"
    );
    return Err(ExitCode::from(2));
  }
  let flag = args.remove(0);
  match flag.as_str() {
    "--public-key-hex" => {
      if args.is_empty() {
        eprintln!("error: --public-key-hex requires a value");
        return Err(ExitCode::from(2));
      }
      Ok(args.remove(0).trim().to_string())
    }
    "--public-key-file" => {
      if args.is_empty() {
        eprintln!("error: --public-key-file requires a path");
        return Err(ExitCode::from(2));
      }
      let path = PathBuf::from(args.remove(0));
      let contents = std::fs::read_to_string(&path).map_err(|err| {
        eprintln!("error: failed to read public key file {}: {err}", path.display());
        ExitCode::from(2)
      })?;
      Ok(contents.trim().to_string())
    }
    other => {
      eprintln!("error: expected --public-key-hex or --public-key-file, got {other}");
      Err(ExitCode::from(2))
    }
  }
}
