// ABOUTME: Google Cloud Text-to-Speech Wasm guest targeting speech-synthesize-world.
// ABOUTME: Decodes bounded provider audio into a host-owned output BlobHandle for playback.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "speech-synthesize-world",
  std_feature,
});

use exports::langnext::runtime_plugin::speech_synthesize::{
  Guest, SynthesizeRequest, SynthesizeResponse,
};
use langnext::runtime_plugin::common::{BlobDirection, MediaMetadata, PluginError};
use langnext::runtime_plugin::host::{
  blob_create, blob_discard, blob_write, broker_fetch, BrokerBodyRequest, BrokerBodyResponse,
  BrokerError, BrokerRequest, BrokerResponse, ResourceError,
};
use langnext_google_cloud_protocol as protocol;

const ACCEPT_JSON: &str = "application/json";
const CONFIG_MAX_BYTES: usize = 64 * 1024;
const SPEAKING_RATE_MIN: f64 = 0.25;
const SPEAKING_RATE_MAX: f64 = 2.0;
const PITCH_MIN: f64 = -20.0;
const PITCH_MAX: f64 = 20.0;
const BLOB_WRITE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Preferences {
  #[serde(default = "default_rate")]
  speaking_rate: f64,
  #[serde(default)]
  pitch: f64,
}

fn default_rate() -> f64 {
  1.0
}

struct Component;

impl Guest for Component {
  fn synthesize(
    config: Vec<u8>,
    request: SynthesizeRequest,
  ) -> Result<SynthesizeResponse, PluginError> {
    if config.len() > CONFIG_MAX_BYTES {
      return Err(PluginError::InvalidConfiguration);
    }
    protocol::validate_config(&config).map_err(map_protocol_error)?;
    if request.text.is_empty() || request.text.len() > 5_000 {
      return Err(PluginError::InvalidRequest(String::from(
        "text is outside the supported bound",
      )));
    }
    let preferences: Preferences = serde_json::from_slice(&request.preferences)
      .map_err(|_| PluginError::InvalidRequest(String::from("invalid speech preferences")))?;
    if !preferences.speaking_rate.is_finite()
      || preferences.speaking_rate < SPEAKING_RATE_MIN
      || preferences.speaking_rate > SPEAKING_RATE_MAX
      || !preferences.pitch.is_finite()
      || preferences.pitch < PITCH_MIN
      || preferences.pitch > PITCH_MAX
    {
      return Err(PluginError::InvalidRequest(String::from(
        "speech preferences are outside the supported bound",
      )));
    }
    let body = protocol::tts_request_body(
      &request.text,
      &request.language_id,
      preferences.speaking_rate,
      preferences.pitch,
    )
    .map_err(map_protocol_error)?;
    let response = broker_fetch(BrokerRequest {
      endpoint_id: String::from(protocol::GOOGLE_TTS_ENDPOINT),
      relative_path: String::from(protocol::GOOGLE_TTS_PATH),
      method: String::from("POST"),
      headers: alloc::vec![(String::from("Accept"), String::from(ACCEPT_JSON))],
      body: BrokerBodyRequest::Json(body),
    })
    .map_err(map_broker_error)?;
    let status = response.status;
    let body = json_body_string(response)?;
    let audio_content = protocol::parse_tts_response(status, &body).map_err(map_protocol_error)?;
    let audio = BASE64.decode(audio_content.as_bytes()).map_err(|_| {
      PluginError::InvalidResponse(String::from("audioContent is not valid standard base64"))
    })?;
    if audio.is_empty() || audio.len() > protocol::SPEECH_AUDIO_MAX_BYTES {
      return Err(PluginError::InvalidResponse(String::from(
        "audio exceeds size limit",
      )));
    }
    if !looks_like_mp3(&audio) {
      return Err(PluginError::InvalidResponse(String::from(
        "audio is not MP3",
      )));
    }
    let handle = blob_create(
      BlobDirection::Output,
      Some(protocol::GOOGLE_TTS_AUDIO_CONTENT_TYPE),
      protocol::SPEECH_AUDIO_MAX_BYTES as u64,
    )
    .map_err(map_resource_error)?;
    let mut offset = 0u64;
    for chunk in audio.chunks(BLOB_WRITE_CHUNK_BYTES) {
      if let Err(error) = blob_write(&handle, offset, chunk) {
        blob_discard(handle);
        return Err(map_resource_error(error));
      }
      offset += chunk.len() as u64;
    }
    Ok(SynthesizeResponse {
      output: handle,
      media: MediaMetadata {
        content_type: Some(String::from(protocol::GOOGLE_TTS_AUDIO_CONTENT_TYPE)),
        byte_length: Some(audio.len() as u64),
      },
    })
  }
}

fn looks_like_mp3(bytes: &[u8]) -> bool {
  bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
}

fn json_body_string(response: BrokerResponse) -> Result<String, PluginError> {
  match response.body {
    BrokerBodyResponse::Json(bytes) => String::from_utf8(bytes)
      .map_err(|_| PluginError::InvalidResponse(String::from("broker returned non-UTF-8 JSON"))),
    _ => Err(PluginError::InvalidResponse(String::from(
      "expected JSON broker body",
    ))),
  }
}

fn map_resource_error(error: ResourceError) -> PluginError {
  match error {
    ResourceError::Cancelled => PluginError::Cancelled,
    ResourceError::Exhausted | ResourceError::OutOfBounds => {
      PluginError::InvalidResponse(String::from("audio exceeds size limit"))
    }
    ResourceError::NotOwned | ResourceError::WrongDirection | ResourceError::Closed => {
      PluginError::Internal(String::from("output blob is unavailable"))
    }
    ResourceError::Internal(_) => PluginError::Internal(String::from("blob resource failed")),
  }
}

fn map_broker_error(error: BrokerError) -> PluginError {
  match error {
    BrokerError::NotApproved
    | BrokerError::MethodNotAllowed
    | BrokerError::PathConfined
    | BrokerError::HeaderBlocked => PluginError::PermissionDenied,
    BrokerError::Network(message) if message == protocol::TOKEN_GRANT_AUTH_FAILURE_MARKER => {
      PluginError::Auth
    }
    BrokerError::Network(_) => PluginError::Network(String::from("network request failed")),
    BrokerError::Timeout => PluginError::Timeout,
    BrokerError::Cancelled => PluginError::Cancelled,
    BrokerError::LimitExceeded => {
      PluginError::InvalidResponse(String::from("response exceeded limit"))
    }
    BrokerError::Internal(_) => PluginError::Internal(String::from("host broker failed")),
  }
}

fn map_protocol_error(error: protocol::ProtocolError) -> PluginError {
  match error {
    protocol::ProtocolError::InvalidRequest => {
      PluginError::InvalidRequest(String::from("invalid request"))
    }
    protocol::ProtocolError::InvalidConfiguration => PluginError::InvalidConfiguration,
    protocol::ProtocolError::UnsupportedInput => {
      PluginError::UnsupportedInput(String::from("unsupported input"))
    }
    protocol::ProtocolError::UnsupportedLanguage => {
      PluginError::UnsupportedLanguage(String::from("unsupported language"))
    }
    protocol::ProtocolError::Auth => PluginError::Auth,
    protocol::ProtocolError::PermissionDenied => PluginError::PermissionDenied,
    protocol::ProtocolError::QuotaExceeded => PluginError::QuotaExceeded,
    protocol::ProtocolError::RateLimited => PluginError::RateLimited,
    protocol::ProtocolError::InvalidResponse => {
      PluginError::InvalidResponse(String::from("invalid provider response"))
    }
    protocol::ProtocolError::ProviderUnavailable => PluginError::ProviderUnavailable,
  }
}

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicUsize, Ordering};

const HEAP_SIZE: usize = 64 * 1024 * 1024;
struct Bump {
  head: AtomicUsize,
  heap: UnsafeCell<[u8; HEAP_SIZE]>,
}
unsafe impl Sync for Bump {}

#[global_allocator]
static ALLOC: Bump = Bump {
  head: AtomicUsize::new(0),
  heap: UnsafeCell::new([0u8; HEAP_SIZE]),
};

unsafe impl GlobalAlloc for Bump {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let size = layout.size();
    let align = layout.align();
    let heap_start = self.heap.get() as *mut u8;
    loop {
      let current = self.head.load(Ordering::Relaxed);
      let aligned = (current + align - 1) & !(align - 1);
      let next = aligned + size;
      if next > HEAP_SIZE {
        #[cfg(target_arch = "wasm32")]
        core::arch::wasm32::unreachable();
        #[cfg(not(target_arch = "wasm32"))]
        panic!("oom");
      }
      if self
        .head
        .compare_exchange(current, next, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
      {
        return heap_start.add(aligned);
      }
    }
  }
  unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    if new_size <= layout.size() {
      return ptr;
    }
    let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
    let new_ptr = self.alloc(new_layout);
    if !new_ptr.is_null() {
      core::ptr::copy_nonoverlapping(ptr, new_ptr, layout.size());
    }
    new_ptr
  }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
  loop {
    core::hint::spin_loop();
  }
}

export!(Component with_types_in self);
