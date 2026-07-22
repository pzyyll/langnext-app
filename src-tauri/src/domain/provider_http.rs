// ABOUTME: Generic provider wire request/response DTOs and raw stream Channel events.
// ABOUTME: No provider-specific parsing; secrets never appear on these types.
use serde::{Deserialize, Serialize};

/// Frontend-built relative wire request. Must not include credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWireRequest {
  pub method: ProviderHttpMethod,
  pub relative_path: String,
  #[serde(default)]
  pub query: Vec<(String, String)>,
  #[serde(default)]
  pub headers: std::collections::HashMap<String, String>,
  pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ProviderHttpMethod {
  Get,
  Post,
}

/// IPC input for a raw provider HTTP request or stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpRequest {
  pub request_id: String,
  pub provider_instance_id: uuid::Uuid,
  pub wire: ProviderWireRequest,
}

/// Bounded raw HTTP response returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpResponse {
  pub status: u16,
  pub headers: std::collections::HashMap<String, String>,
  pub body: String,
}

/// Per-call Channel events for raw streaming responses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum ProviderHttpStreamEvent {
  #[serde(rename = "started")]
  Started {
    status: u16,
    headers: std::collections::HashMap<String, String>,
  },
  #[serde(rename = "chunk")]
  Chunk { bytes: Vec<u8> },
  #[serde(rename = "finished")]
  Finished,
}
