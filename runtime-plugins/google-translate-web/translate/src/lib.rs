// ABOUTME: Google Translate Web Wasm guest targeting translate-text-world.
// ABOUTME: Ports GTX/HTTPS-proxy translate request construction and response parsing over host.broker.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;

// `std_feature` keeps generated bindings no_std unless the optional empty `std` feature is enabled.
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
use langnext_google_translate_web_protocol as protocol;

/// Endpoint alias for the pinned GTX origin (host grant resolves the origin).
const GTX_ENDPOINT: &str = "gtx";
/// Endpoint alias for the instance-configured HTTPS proxy origin.
const PROXY_ENDPOINT: &str = "https-proxy";
struct Component;

impl Guest for Component {
    fn text(
        config: Vec<u8>,
        _preferences: Vec<u8>,
        request: TextRequest,
    ) -> Result<TextResponse, PluginError> {
        let channel = protocol::extract_channel(&config);
        match channel {
            protocol::Channel::Gtx => translate_via_gtx(&request),
            protocol::Channel::HttpsProxy => translate_via_proxy(&config, &request),
        }
    }
}

fn translate_via_gtx(request: &TextRequest) -> Result<TextResponse, PluginError> {
    let target = protocol::app_language_to_google(&request.target_language_id)
        .ok_or_else(|| PluginError::UnsupportedLanguage(request.target_language_id.clone()))?;
    let source =
        protocol::gtx_source_language(&request.source_language_id).map_err(map_protocol_error)?;
    let relative_path = protocol::gtx_relative_path(source, target, &request.text);
    let broker_request = BrokerRequest {
        endpoint_id: String::from(GTX_ENDPOINT),
        relative_path,
        method: String::from("GET"),
        headers: Vec::new(),
        body: BrokerBodyRequest::Empty,
    };
    let response = broker_fetch(broker_request).map_err(map_broker_error)?;
    let body = json_body_string(&response)?;
    let parsed = protocol::parse_gtx_translate_response(response.status, &body)
        .map_err(map_protocol_error)?;
    Ok(TextResponse {
        translated_text: parsed.translated_text,
        detected_source_language_id: parsed.detected_source_language_id,
    })
}

fn translate_via_proxy(config: &[u8], request: &TextRequest) -> Result<TextResponse, PluginError> {
    let target = protocol::app_language_to_google(&request.target_language_id)
        .ok_or_else(|| PluginError::UnsupportedLanguage(request.target_language_id.clone()))?;
    let source =
        protocol::proxy_source_language(&request.source_language_id).map_err(map_protocol_error)?;
    let relative_path =
        protocol::extract_proxy_relative_path(config).map_err(map_protocol_error)?;
    let body_bytes = protocol::proxy_request_body(&request.text, source, target);
    let broker_request = BrokerRequest {
        endpoint_id: String::from(PROXY_ENDPOINT),
        relative_path,
        method: String::from("POST"),
        headers: Vec::new(),
        body: BrokerBodyRequest::Json(body_bytes),
    };
    let response = broker_fetch(broker_request).map_err(map_broker_error)?;
    let body = json_body_string(&response)?;
    let translated = protocol::parse_proxy_translate_response(response.status, &body)
        .map_err(map_protocol_error)?;
    Ok(TextResponse {
        translated_text: translated,
        detected_source_language_id: None,
    })
}

/// Extract the JSON response body as a UTF-8 string. Non-JSON bodies and non-UTF-8 bytes fail closed.
fn json_body_string(response: &BrokerResponse) -> Result<String, PluginError> {
    match &response.body {
        BrokerBodyResponse::Json(bytes) => String::from_utf8(bytes.clone())
            .map_err(|_| PluginError::InvalidResponse(String::from("non-utf8 broker body"))),
        _ => Err(PluginError::InvalidResponse(String::from(
            "expected json body",
        ))),
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
        BrokerError::LimitExceeded => {
            PluginError::InvalidResponse(String::from("response exceeded limit"))
        }
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
