// ABOUTME: Google Translate Web Wasm guest targeting translate-detect-world.
// ABOUTME: Detect always uses pinned GTX (host product contract) over host.broker.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;

// `std_feature` keeps generated bindings no_std unless the optional empty `std` feature is enabled.
wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "translate-detect-world",
  std_feature,
});

use exports::langnext::runtime_plugin::translate_detect::{DetectRequest, DetectResponse, Guest};
use langnext::runtime_plugin::common::PluginError;
use langnext::runtime_plugin::host::{
  broker_fetch, BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest, BrokerResponse,
};
use langnext_google_translate_web_protocol as protocol;

/// Endpoint alias for the pinned GTX origin (detect never uses the proxy channel).
const GTX_ENDPOINT: &str = "gtx";
/// Fixed target used for the detect probe; only the detected-language slot is consumed.
const DETECT_PROBE_TARGET: &str = "en";

struct Component;

impl Guest for Component {
  fn detect(
    _config: Vec<u8>,
    _preferences: Vec<u8>,
    request: DetectRequest,
  ) -> Result<DetectResponse, PluginError> {
    // Detect uses source=auto and a fixed target; only the detected-language slot is used.
    let relative_path = protocol::gtx_relative_path("auto", DETECT_PROBE_TARGET, &request.text);
    let broker_request = BrokerRequest {
      endpoint_id: String::from(GTX_ENDPOINT),
      relative_path,
      method: String::from("GET"),
      headers: Vec::new(),
      body: BrokerBodyRequest::Empty,
    };
    let response = broker_fetch(broker_request).map_err(map_broker_error)?;
    let body = json_body_string(&response)?;
    let parsed = protocol::parse_gtx_detect_response(response.status, &body).map_err(map_protocol_error)?;
    Ok(DetectResponse {
      language_id: parsed.language_id,
      // The free GTX endpoint does not return a confidence value; leave it absent.
      confidence: None,
    })
  }
}

/// Extract the JSON response body as a UTF-8 string. Non-JSON bodies and non-UTF-8 bytes fail closed.
fn json_body_string(response: &BrokerResponse) -> Result<String, PluginError> {
  match &response.body {
    BrokerBodyResponse::Json(bytes) => String::from_utf8(bytes.clone())
      .map_err(|_| PluginError::InvalidResponse(String::from("non-utf8 broker body"))),
    _ => Err(PluginError::InvalidResponse(String::from("expected json body"))),
  }
}

fn map_broker_error(error: BrokerError) -> PluginError {
  match error {
    BrokerError::NotApproved => PluginError::PermissionDenied,
    BrokerError::MethodNotAllowed => PluginError::PermissionDenied,
    BrokerError::PathConfined => PluginError::PermissionDenied,
    BrokerError::HeaderBlocked => PluginError::PermissionDenied,
    BrokerError::Network(msg) => PluginError::Network(msg),
    BrokerError::Timeout => PluginError::Timeout,
    BrokerError::Cancelled => PluginError::Cancelled,
    BrokerError::LimitExceeded => PluginError::InvalidResponse(String::from("response exceeded limit")),
    BrokerError::Internal(msg) => PluginError::Internal(msg),
  }
}

fn map_protocol_error(error: protocol::ProtocolError) -> PluginError {
  match error {
    protocol::ProtocolError::InvalidRequest(msg) => PluginError::InvalidRequest(msg),
    protocol::ProtocolError::InvalidConfiguration => PluginError::InvalidConfiguration,
    protocol::ProtocolError::InvalidInput(msg) => PluginError::InvalidInput(msg),
    protocol::ProtocolError::PermissionDenied => PluginError::PermissionDenied,
    protocol::ProtocolError::RateLimited => PluginError::RateLimited,
    protocol::ProtocolError::UnsupportedLanguage(msg) => PluginError::UnsupportedLanguage(msg),
    protocol::ProtocolError::Network(msg) => PluginError::Network(msg),
    protocol::ProtocolError::Timeout => PluginError::Timeout,
    protocol::ProtocolError::InvalidResponse(msg) => PluginError::InvalidResponse(msg),
    protocol::ProtocolError::ProviderUnavailable => PluginError::ProviderUnavailable,
    protocol::ProtocolError::Cancelled => PluginError::Cancelled,
    protocol::ProtocolError::Internal(msg) => PluginError::Internal(msg),
  }
}

// --- Minimal no_std bump allocator (leaks; sufficient for a short-lived guest) ---
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
