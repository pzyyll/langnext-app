// ABOUTME: Native worker runtime descriptors, protocol frame constants, and stable errors.
// ABOUTME: Process isolation only; first-party vendor-signed workers are not a permission sandbox.
use serde::{Deserialize, Serialize};

/// Native protocol version required by the host for Phase 10 workers.
pub const NATIVE_PROTOCOL_VERSION_V1: u32 = 1;
/// Maximum number of declared native DLL dependencies in a package.
pub const NATIVE_DEPENDENCIES_MAX_COUNT: usize = 256;
/// Fixed frame magic for length-prefixed native protocol frames.
pub const NATIVE_FRAME_MAGIC: u32 = 0x4C4E_5750; // "LNWP"
/// Maximum single protocol frame payload size (16 MiB).
pub const NATIVE_FRAME_MAX_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum stdout/stderr capture before flood termination (1 MiB).
pub const NATIVE_WORKER_STDIO_MAX_BYTES: u64 = 1024 * 1024;
/// Startup handshake deadline.
pub const NATIVE_WORKER_STARTUP_TIMEOUT_MS: u64 = 15_000;
/// Cooperative shutdown deadline before process-tree kill.
pub const NATIVE_WORKER_SHUTDOWN_TIMEOUT_MS: u64 = 3_000;
/// OCR request deadline default.
pub const NATIVE_WORKER_OCR_TIMEOUT_MS: u64 = 30_000;
/// First-party PaddleOCR plugin id allowed for trusted-native-worker packages.
pub const PADDLEOCR_PLUGIN_ID: &str = "com.langnext.paddleocr";
/// First-party PaddleOCR package version for the initial release slice.
pub const PADDLEOCR_PLUGIN_VERSION: &str = "1.0.0";
/// Canonical worker executable path inside the signed package runtime directory.
pub const NATIVE_WORKER_ARTIFACT_PATH: &str = "runtime/worker.exe";
/// Independently authored golden OCR text for host routing / protocol fixtures.
/// Not a claim about production PaddleOCR model accuracy (blocked without SDK inventory).
pub const PADDLEOCR_OCR_GOLDEN_TEXT: &str = "LANGNEXT OCR GOLDEN V1";

/// Frame kinds exchanged with a native worker over framed stdio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[repr(u16)]
pub enum NativeFrameKind {
  Handshake = 1,
  Ready = 2,
  OcrImageRequest = 3,
  OcrImageResponse = 4,
  Error = 5,
  Shutdown = 6,
  Cancel = 7,
}

impl NativeFrameKind {
  pub fn from_u16(value: u16) -> Option<Self> {
    match value {
      1 => Some(Self::Handshake),
      2 => Some(Self::Ready),
      3 => Some(Self::OcrImageRequest),
      4 => Some(Self::OcrImageResponse),
      5 => Some(Self::Error),
      6 => Some(Self::Shutdown),
      7 => Some(Self::Cancel),
      _ => None,
    }
  }

  pub fn as_u16(self) -> u16 {
    self as u16
  }
}

/// Host → worker handshake payload (versioned, digest-bound).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeHandshakeRequest {
  pub protocol_version: u32,
  pub package_digest: String,
  pub runtime_set_digest: String,
  pub model_set_digest: String,
  pub process_nonce: String,
  pub model_api_version: u32,
}

/// Worker → host ready payload after model initialization and dependency load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeReadyResponse {
  pub protocol_version: u32,
  pub package_digest: String,
  pub runtime_set_digest: String,
  pub model_set_digest: String,
  pub process_nonce: String,
  pub model_api_version: u32,
}

/// OCR request frame payload (internal; public contract remains pngBase64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeOcrImageRequest {
  pub request_id: String,
  pub png_bytes: Vec<u8>,
}

/// OCR response frame payload (text only for ocr.image@1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeOcrImageResponse {
  pub request_id: String,
  pub text: String,
}

/// Stable native worker error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeWorkerErrorCode {
  WorkerCrashed,
  WorkerTimeout,
  HandshakeFailed,
  ProtocolError,
  RuntimeDigestMismatch,
  ModelDigestMismatch,
  SpawnFailed,
  Flood,
  ChildProcess,
  ShutdownIgnored,
  /// Job Object / process-group terminate failed; the process tree may still be live.
  ProcessTreeCleanupFailed,
}

impl NativeWorkerErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::WorkerCrashed => "worker_crashed",
      Self::WorkerTimeout => "worker_timeout",
      Self::HandshakeFailed => "handshake_failed",
      Self::ProtocolError => "protocol_error",
      Self::RuntimeDigestMismatch => "runtime_digest_mismatch",
      Self::ModelDigestMismatch => "model_digest_mismatch",
      Self::SpawnFailed => "spawn_failed",
      Self::Flood => "stdio_flood",
      Self::ChildProcess => "child_process",
      Self::ShutdownIgnored => "shutdown_ignored",
      Self::ProcessTreeCleanupFailed => "process_tree_cleanup_failed",
    }
  }
}

/// Sanitized worker health for composition with integration capability health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeWorkerHealth {
  Unvalidated,
  Ready,
  Degraded,
}

/// True when a DLL basename is a Windows system/API-set module that must never be packaged.
pub fn is_windows_system_or_api_set_module(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  if lower.starts_with("api-ms-win-") || lower.starts_with("ext-ms-win-") {
    return true;
  }
  // Common System32 modules never packaged as runtime-artifact entries.
  matches!(
    lower.as_str(),
    "kernel32.dll"
      | "kernelbase.dll"
      | "ntdll.dll"
      | "user32.dll"
      | "gdi32.dll"
      | "advapi32.dll"
      | "shell32.dll"
      | "ole32.dll"
      | "oleaut32.dll"
      | "ws2_32.dll"
      | "bcrypt.dll"
      | "crypt32.dll"
      | "secur32.dll"
      | "rpcrt4.dll"
      | "combase.dll"
      | "msvcrt.dll"
      | "ucrtbase.dll"
      | "sechost.dll"
      | "shlwapi.dll"
      | "imm32.dll"
      | "winmm.dll"
      | "version.dll"
      | "setupapi.dll"
      | "cfgmgr32.dll"
      | "powrprof.dll"
      | "profapi.dll"
      | "wintrust.dll"
      | "imagehlp.dll"
      | "dbghelp.dll"
      | "psapi.dll"
      | "iphlpapi.dll"
      | "dnsapi.dll"
      | "mswsock.dll"
      | "wldap32.dll"
      | "cryptbase.dll"
      | "sspicli.dll"
      | "userenv.dll"
      | "wtsapi32.dll"
  )
}

/// Normalize a runtime dependency path: must be `runtime/<name>.dll`, unique after normalize.
pub fn normalize_native_dependency_path(path: &str) -> Result<String, String> {
  let trimmed = path.trim();
  if trimmed != path {
    return Err("native dependency path must not have surrounding whitespace".into());
  }
  if trimmed.is_empty() {
    return Err("native dependency path is required".into());
  }
  if trimmed.contains('\\') || trimmed.starts_with('/') || trimmed.contains("..") {
    return Err(format!("native dependency path is invalid: {trimmed}"));
  }
  let lower = trimmed.to_ascii_lowercase();
  if !lower.starts_with("runtime/") || !lower.ends_with(".dll") {
    return Err(format!("native dependency must be runtime/*.dll: {trimmed}"));
  }
  let file_name = lower.rsplit('/').next().unwrap_or("");
  if is_windows_system_or_api_set_module(file_name) {
    return Err(format!("system/API-set module must not be packaged: {trimmed}"));
  }
  // Canonical form: lowercase path for stable comparison.
  Ok(lower)
}

/// Normalize the single native worker executable path: must be exactly one `.exe` under runtime/.
pub fn normalize_native_worker_artifact_path(path: &str) -> Result<String, String> {
  let trimmed = path.trim();
  if trimmed != path {
    return Err("native worker artifact path must not have surrounding whitespace".into());
  }
  let lower = trimmed.to_ascii_lowercase();
  if lower != NATIVE_WORKER_ARTIFACT_PATH {
    return Err(format!(
      "native worker artifact must be {NATIVE_WORKER_ARTIFACT_PATH}, got {trimmed}"
    ));
  }
  Ok(lower)
}
