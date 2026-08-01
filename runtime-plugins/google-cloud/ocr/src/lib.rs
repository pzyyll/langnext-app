// ABOUTME: Google Cloud Vision OCR Wasm guest targeting the frozen ocr-image-world ABI.
// ABOUTME: Reads host-owned PNG bytes through BlobHandle and sends only the provider JSON wire body.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "ocr-image-world",
  std_feature,
});

use exports::langnext::runtime_plugin::ocr_image::{Guest, ImageRequest, ImageResponse};
use langnext::runtime_plugin::common::{BlobHandle, PluginError};
use langnext::runtime_plugin::host::{
  blob_length, blob_read, broker_fetch, BrokerBodyRequest, BrokerBodyResponse, BrokerError,
  BrokerRequest, BrokerResponse, ResourceError,
};
use langnext_google_cloud_protocol as protocol;

const ACCEPT_JSON: &str = "application/json";
const BLOB_READ_CHUNK_BYTES: u64 = 64 * 1024;
const CONFIG_MAX_BYTES: usize = 64 * 1024;

struct Component;

impl Guest for Component {
  fn image(config: Vec<u8>, request: ImageRequest) -> Result<ImageResponse, PluginError> {
    if config.len() > CONFIG_MAX_BYTES {
      return Err(PluginError::InvalidConfiguration);
    }
    protocol::validate_config(&config).map_err(map_protocol_error)?;
    let image_bytes = read_input_blob(&request.input)?;
    let image_base64 = BASE64.encode(image_bytes);
    if image_base64.len() > ((protocol::OCR_IMAGE_MAX_DECODED_BYTES + 2) / 3) * 4 {
      return Err(PluginError::UnsupportedInput(String::from(
        "PNG exceeds size limit",
      )));
    }
    let operation = request
      .preferences
      .operation
      .as_deref()
      .unwrap_or("document_text_detection");
    let body = protocol::vision_request_body(
      &image_base64,
      operation,
      &request.preferences.language_hints,
    )
    .map_err(map_protocol_error)?;
    let response = broker_fetch(BrokerRequest {
      endpoint_id: String::from(protocol::GOOGLE_VISION_ENDPOINT),
      relative_path: String::from(protocol::GOOGLE_VISION_PATH),
      method: String::from("POST"),
      headers: alloc::vec![(String::from("Accept"), String::from(ACCEPT_JSON))],
      body: BrokerBodyRequest::Json(body),
    })
    .map_err(map_broker_error)?;
    let status = response.status;
    let body = json_body_string(response)?;
    let text = protocol::parse_vision_response(status, &body).map_err(map_protocol_error)?;
    Ok(ImageResponse { text })
  }
}

fn read_input_blob(handle: &BlobHandle) -> Result<Vec<u8>, PluginError> {
  let length = blob_length(handle).map_err(map_resource_error)?;
  if length == 0 || length > protocol::OCR_IMAGE_MAX_DECODED_BYTES as u64 {
    return Err(PluginError::UnsupportedInput(String::from(
      "PNG exceeds size limit",
    )));
  }
  let mut bytes = Vec::with_capacity(length as usize);
  let mut offset = 0u64;
  while offset < length {
    let chunk = blob_read(handle, offset, BLOB_READ_CHUNK_BYTES).map_err(map_resource_error)?;
    if chunk.is_empty() {
      return Err(PluginError::InvalidResponse(String::from(
        "input blob ended unexpectedly",
      )));
    }
    offset = offset.saturating_add(chunk.len() as u64);
    bytes.extend_from_slice(&chunk);
  }
  if bytes.len() as u64 != length {
    return Err(PluginError::InvalidResponse(String::from(
      "input blob length changed",
    )));
  }
  Ok(bytes)
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
    ResourceError::OutOfBounds | ResourceError::Exhausted => {
      PluginError::UnsupportedInput(String::from("input blob exceeds limit"))
    }
    ResourceError::NotOwned | ResourceError::WrongDirection | ResourceError::Closed => {
      PluginError::InvalidResponse(String::from("input blob is unavailable"))
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
