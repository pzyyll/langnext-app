// ABOUTME: Offline CLI for finalizing, verifying, and signing `.lnplugin` packages.
// ABOUTME: Never reads private keys; sign-staging accepts a developer seed hex and places manifest.sig.
use ed25519_dalek::{Signer, SigningKey};
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
    "sign-staging" => cmd_sign_staging(args),
    "derive-public-key" => cmd_derive_public_key(args),
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
  eprintln!("  plugin_tool derive-public-key <64-char-hex-seed>");
  eprintln!("  plugin_tool sign-staging <staging-dir> <64-char-hex-seed>");
  eprintln!("  plugin_tool verify <package.lnplugin> --public-key-hex <hex>");
  eprintln!("  plugin_tool verify <package.lnplugin> --public-key-file <path>");
  eprintln!("  plugin_tool finalize-package <staging-dir> <output.lnplugin> --public-key-hex <hex>");
  eprintln!("  plugin_tool finalize-package <staging-dir> <output.lnplugin> --public-key-file <path>");
}

fn cmd_sign_staging(mut args: Vec<String>) -> ExitCode {
  if args.len() < 2 {
    eprintln!("error: sign-staging requires <staging-dir> <64-char-hex-seed>");
    return ExitCode::from(2);
  }
  let staging = PathBuf::from(args.remove(0));
  let seed_hex = args.remove(0).trim().to_ascii_lowercase();

  if seed_hex.len() != 64 || !seed_hex.chars().all(|c| c.is_ascii_hexdigit()) {
    eprintln!(
      "error: seed must be 64 lowercase hex chars (32 bytes), got length {}",
      seed_hex.len()
    );
    return ExitCode::from(2);
  }
  if !args.is_empty() {
    eprintln!("error: unexpected arguments: {}", args.join(" "));
    return ExitCode::from(2);
  }

  let manifest_path = staging.join("plugin.json");
  if !manifest_path.is_file() {
    eprintln!("error: plugin.json not found at {}", manifest_path.display());
    return ExitCode::from(1);
  }
  let manifest_bytes = match std::fs::read(&manifest_path) {
    Ok(b) => b,
    Err(err) => {
      eprintln!("error: failed to read {}: {err}", manifest_path.display());
      return ExitCode::from(1);
    }
  };

  let seed: [u8; 32] = match decode_hex_32(&seed_hex).map_err(|msg| format!("invalid seed hex: {msg}")) {
    Ok(b) => b,
    Err(message) => {
      eprintln!("error: {message}");
      return ExitCode::from(1);
    }
  };
  let signing_key = SigningKey::from_bytes(&seed);
  let signature = signing_key.sign(&manifest_bytes).to_bytes().to_vec();

  let sig_dir = staging.join("signatures");
  if let Err(err) = std::fs::create_dir_all(&sig_dir) {
    eprintln!("error: failed to create {}: {err}", sig_dir.display());
    return ExitCode::from(1);
  }
  let sig_path = sig_dir.join("manifest.sig");
  if let Err(err) = std::fs::write(&sig_path, &signature) {
    eprintln!("error: failed to write {}: {err}", sig_path.display());
    return ExitCode::from(1);
  }
  println!(
    "ok: signed plugin.json ({} bytes) -> {}",
    manifest_bytes.len(),
    sig_path.display()
  );
  ExitCode::SUCCESS
}

/// Decode 64 lowercase hex chars into 32 bytes.
fn decode_hex_32(hex: &str) -> Result<[u8; 32], String> {
  let hex = hex.trim();
  if hex.len() != 64 {
    return Err(format!("{} characters; need exactly 64", hex.len()));
  }
  let mut out = [0u8; 32];
  for (idx, chunk) in hex.as_bytes().chunks(2).enumerate() {
    let high = hex_nibble(chunk[0])?;
    let low = hex_nibble(chunk[1])?;
    out[idx] = (high << 4) | low;
  }
  Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8, String> {
  match b {
    b'0'..=b'9' => Ok(b - b'0'),
    b'a'..=b'f' => Ok(b - b'a' + 10),
    _ => Err(format!("invalid hex char '{}'", b as char)),
  }
}

fn cmd_derive_public_key(mut args: Vec<String>) -> ExitCode {
  if args.is_empty() {
    eprintln!("error: derive-public-key requires <64-char-hex-seed>");
    return ExitCode::from(2);
  }
  let seed_hex = args.remove(0).trim().to_ascii_lowercase();
  if seed_hex.len() != 64 || !seed_hex.chars().all(|c| c.is_ascii_hexdigit()) {
    eprintln!("error: seed must be 64 lowercase hex chars (32 bytes)");
    return ExitCode::from(2);
  }
  let seed: [u8; 32] = match decode_hex_32(&seed_hex) {
    Ok(b) => b,
    Err(message) => {
      eprintln!("error: {message}");
      return ExitCode::from(1);
    }
  };
  let signing_key = SigningKey::from_bytes(&seed);
  let verifying_key = signing_key.verifying_key();
  let pub_bytes = verifying_key.to_bytes();
  let pub_hex: String = pub_bytes.iter().map(|b| format!("{b:02x}")).collect();
  let fp = sha256_hex(&pub_bytes);
  println!("public_key  = {pub_hex}");
  println!("fingerprint = {fp}");
  ExitCode::SUCCESS
}

fn sha256_hex(data: &[u8]) -> String {
  use sha2::Digest;
  let mut hasher = sha2::Sha256::new();
  hasher.update(data);
  hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
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
