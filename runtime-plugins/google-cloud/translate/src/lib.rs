// ABOUTME: Google Cloud Translate Wasm guest targeting the frozen translate-text-world ABI.
// ABOUTME: Builds v3beta1 requests over the host broker and returns normalized translation data.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "translate-text-world",
  std_feature,
});

use exports::langnext::runtime_plugin::translate_text::{Guest, TextRequest, TextResponse};
use langnext::runtime_plugin::common::PluginError;
use langnext::runtime_plugin::host::{
  broker_fetch, BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest, BrokerResponse,
};
use langnext_google_cloud_protocol as protocol;

const ACCEPT_JSON: &str = "application/json";
const CONFIG_MAX_BYTES: usize = 64 * 1024;

struct Component;

impl Guest for Component {
  fn text(
    config: Vec<u8>,
    _preferences: Vec<u8>,
    request: TextRequest,
  ) -> Result<TextResponse, PluginError> {
    if config.len() > CONFIG_MAX_BYTES {
      return Err(PluginError::InvalidConfiguration);
    }
    protocol::validate_config(&config).map_err(map_protocol_error)?;
    if request.text.is_empty() || request.text.len() > protocol::CAPABILITY_TEXT_MAX_BYTES {
      return Err(PluginError::InvalidRequest(String::from(
        "text is outside the supported bound",
      )));
    }
    let (project, location) =
      protocol::config_project_location(&config).map_err(map_protocol_error)?;
    let (relative_path, body) = protocol::translate_request_body(
      &request.text,
      &request.source_language_id,
      &request.target_language_id,
      &project,
      &location,
    )
    .map_err(map_protocol_error)?;
    let response = broker_fetch(BrokerRequest {
      endpoint_id: String::from(protocol::GOOGLE_TRANSLATE_ENDPOINT),
      relative_path,
      method: String::from("POST"),
      headers: alloc::vec![(String::from("Accept"), String::from(ACCEPT_JSON))],
      body: BrokerBodyRequest::Json(body),
    })
    .map_err(map_broker_error)?;
    let status = response.status;
    let body = json_body_string(response)?;
    let parsed = protocol::parse_translate_response(status, &body).map_err(map_protocol_error)?;
    Ok(TextResponse {
      translated_text: parsed.translated_text,
      detected_source_language_id: parsed.detected_source_language_id,
    })
  }
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

const HEAP_SIZE: usize = 4 * 1024 * 1024;
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
