// ABOUTME: Signed model-resource descriptors, status DTOs, and stable model errors.
// ABOUTME: Model bytes stay host-managed product resources, never plugin package contents.
use serde::{Deserialize, Serialize};

/// Model resource identifier max length (reverse-domain style).
pub const MODEL_RESOURCE_ID_MAX_LEN: usize = 64;
/// Maximum artifacts declared on one model resource (detection + recognition for PaddleOCR).
pub const MODEL_RESOURCE_ARTIFACTS_MAX_COUNT: usize = 8;
/// Maximum expanded files declared on one model resource.
pub const MODEL_RESOURCE_FILES_MAX_COUNT: usize = 64;
/// Maximum model resource declarations on one package.
pub const MODEL_RESOURCES_MAX_COUNT: usize = 8;
/// Locked 150 MiB total-download cap for the first PaddleOCR model bundle.
pub const MODEL_TOTAL_DOWNLOAD_MAX_BYTES: u64 = 150 * 1024 * 1024;
/// Locked 150 MiB expanded-size cap for the first PaddleOCR model bundle.
pub const MODEL_EXPANDED_MAX_BYTES: u64 = 150 * 1024 * 1024;
/// Exact expanded-file count for the locked PP-OCRv6 medium bundle.
pub const PADDLEOCR_MODEL_EXPANDED_FILE_COUNT: usize = 6;
/// Official PP-OCRv6 medium model resource id.
pub const PADDLEOCR_MODEL_RESOURCE_ID: &str = "pp-ocrv6-medium";
/// Model API version bound into the worker handshake for PP-OCRv6 medium.
pub const PADDLEOCR_MODEL_API_VERSION: u32 = 1;
/// Bounded connect timeout for host-managed model artifact downloads.
pub const MODEL_DOWNLOAD_CONNECT_TIMEOUT_MS: u64 = 30_000;
/// Bounded idle/read timeout between successful body chunks (cancel delay bound).
pub const MODEL_DOWNLOAD_READ_TIMEOUT_MS: u64 = 120_000;
/// Bounded overall timeout for a single model artifact HTTP request.
pub const MODEL_DOWNLOAD_OVERALL_TIMEOUT_MS: u64 = 600_000;

/// Role of a downloadable model archive artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelArtifactRole {
  Detection,
  Recognition,
}

/// Role of an expanded model file inside a verified model root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelFileRole {
  Detection,
  Recognition,
}

/// One pinned official model archive (URL + size + digest). Host resolves; frontend never supplies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelArtifactDescriptor {
  pub role: ModelArtifactRole,
  pub url: String,
  pub bytes: u64,
  pub sha256: String,
}

/// One expanded file inside the installed model resource root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFileDescriptor {
  pub path: String,
  pub role: ModelFileRole,
  pub bytes: u64,
  pub sha256: String,
}

/// Signed top-level model resource declaration. Package contains metadata only, never model bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelResourceDescriptor {
  pub id: String,
  pub version: String,
  pub model_api_version: u32,
  pub language_set: String,
  pub total_download_bytes: u64,
  pub expanded_bytes: u64,
  pub license_id: String,
  pub license_notice_path: String,
  pub artifacts: Vec<ModelArtifactDescriptor>,
  pub files: Vec<ModelFileDescriptor>,
}

/// Public model resource readiness state exposed over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginModelResourceStatus {
  Missing,
  Downloading,
  Ready,
  Failed,
}

impl PluginModelResourceStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Missing => "missing",
      Self::Downloading => "downloading",
      Self::Ready => "ready",
      Self::Failed => "failed",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "missing" => Ok(Self::Missing),
      "downloading" => Ok(Self::Downloading),
      "ready" => Ok(Self::Ready),
      "failed" => Ok(Self::Failed),
      other => Err(format!("unknown model resource status: {other}")),
    }
  }
}

/// Sanitized model resource DTO: no absolute paths, URLs, archive internals, or raw errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginModelResourceDto {
  pub model_id: String,
  pub version: String,
  pub model_api_version: u32,
  pub language_set: String,
  pub status: PluginModelResourceStatus,
  pub expected_download_bytes: u64,
  pub installed_bytes: Option<u64>,
  pub license_label: String,
  pub error_code: Option<String>,
}

/// Explicit download input: host resolves URL/digests/caps from the signed package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadPluginModelInput {
  pub instance_id: String,
  pub model_id: String,
}

/// Cancel input: only the matching in-flight operation is cancelled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelPluginModelDownloadInput {
  pub instance_id: String,
  pub model_id: String,
  pub operation_id: String,
}

/// Bounded progress event on the download Channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginModelDownloadProgress {
  pub operation_id: String,
  pub model_id: String,
  pub bytes_downloaded: u64,
  pub total_bytes: u64,
  pub phase: PluginModelDownloadPhase,
}

/// Progress phase for sanitized UI copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginModelDownloadPhase {
  Starting,
  Downloading,
  Verifying,
  Installing,
  Ready,
  Failed,
  Cancelled,
}

/// Stable model error codes returned to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginModelErrorCode {
  ModelMissing,
  ModelDownloading,
  ModelFailed,
  DigestMismatch,
  SizeExceeded,
  UnsafeArchive,
  Cancelled,
  NotNativePackage,
  InstanceNotFound,
  StalePackage,
  OperationNotFound,
  ConcurrentDownload,
}

impl PluginModelErrorCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::ModelMissing => "model_missing",
      Self::ModelDownloading => "model_downloading",
      Self::ModelFailed => "model_failed",
      Self::DigestMismatch => "digest_mismatch",
      Self::SizeExceeded => "size_exceeded",
      Self::UnsafeArchive => "unsafe_archive",
      Self::Cancelled => "cancelled",
      Self::NotNativePackage => "not_native_package",
      Self::InstanceNotFound => "instance_not_found",
      Self::StalePackage => "stale_package",
      Self::OperationNotFound => "operation_not_found",
      Self::ConcurrentDownload => "concurrent_download",
    }
  }
}

/// Pinned official PP-OCRv6 medium detection archive (verified 2026-08-06).
pub const PADDLEOCR_DET_URL: &str = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_infer.tar";
pub const PADDLEOCR_DET_BYTES: u64 = 62_279_680;
pub const PADDLEOCR_DET_SHA256: &str = "144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7";

/// Pinned official PP-OCRv6 medium recognition archive (verified 2026-08-06).
pub const PADDLEOCR_REC_URL: &str = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_infer.tar";
pub const PADDLEOCR_REC_BYTES: u64 = 76_851_200;
pub const PADDLEOCR_REC_SHA256: &str = "4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6";

/// Total download size of both official TAR archives.
pub const PADDLEOCR_TOTAL_DOWNLOAD_BYTES: u64 = 139_130_880;
/// Total expanded size of the six declared model files.
pub const PADDLEOCR_EXPANDED_BYTES: u64 = 139_110_993;

/// Build the locked PP-OCRv6 medium model resource descriptor used by package fixtures.
pub fn paddleocr_medium_model_resource(license_notice_path: &str) -> ModelResourceDescriptor {
  ModelResourceDescriptor {
    id: PADDLEOCR_MODEL_RESOURCE_ID.into(),
    version: "1.0.0".into(),
    model_api_version: PADDLEOCR_MODEL_API_VERSION,
    language_set: "pp-ocrv6-50lang".into(),
    total_download_bytes: PADDLEOCR_TOTAL_DOWNLOAD_BYTES,
    expanded_bytes: PADDLEOCR_EXPANDED_BYTES,
    license_id: "paddleocr-model-weights".into(),
    license_notice_path: license_notice_path.into(),
    artifacts: vec![
      ModelArtifactDescriptor {
        role: ModelArtifactRole::Detection,
        url: PADDLEOCR_DET_URL.into(),
        bytes: PADDLEOCR_DET_BYTES,
        sha256: PADDLEOCR_DET_SHA256.into(),
      },
      ModelArtifactDescriptor {
        role: ModelArtifactRole::Recognition,
        url: PADDLEOCR_REC_URL.into(),
        bytes: PADDLEOCR_REC_BYTES,
        sha256: PADDLEOCR_REC_SHA256.into(),
      },
    ],
    files: vec![
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_det_infer/inference.json".into(),
        role: ModelFileRole::Detection,
        bytes: 312_150,
        sha256: "0f1a7ec35da36173529c7a60238b7f7919e3831929c3f700ad90ad4896adecd5".into(),
      },
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_det_infer/inference.pdiparams".into(),
        role: ModelFileRole::Detection,
        bytes: 61_960_476,
        sha256: "85218d2e3d98f5a21c58b4220627be923a97aee5db3cc71f39536ab31ac53960".into(),
      },
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_det_infer/inference.yml".into(),
        role: ModelFileRole::Detection,
        bytes: 886,
        sha256: "7298d5ead546584af2504d03355f881ac7a7bc0eb1e282d3e159277c1d0af871".into(),
      },
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_rec_infer/inference.json".into(),
        role: ModelFileRole::Recognition,
        bytes: 221_814,
        sha256: "0b2e25e990bd072f1bf77d59d67d508bce6c4bd44af6624e0fb27d6da2cd00e8".into(),
      },
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_rec_infer/inference.pdiparams".into(),
        role: ModelFileRole::Recognition,
        bytes: 76_465_087,
        sha256: "1b01c79a914587933f615569e75de54f2e638ebb5d3f3b3c1b38c24ede8c7319".into(),
      },
      ModelFileDescriptor {
        path: "PP-OCRv6_medium_rec_infer/inference.yml".into(),
        role: ModelFileRole::Recognition,
        bytes: 150_580,
        sha256: "991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129".into(),
      },
    ],
  }
}
