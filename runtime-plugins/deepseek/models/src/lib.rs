// ABOUTME: DeepSeek llm-models-world Component: lists models through the host broker; ports
// ABOUTME: GET /models with bounded page parsing; ids only (no remote display names).
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

// `std_feature` keeps generated bindings no_std unless the optional empty `std` feature is enabled.
wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "llm-models-world",
  std_feature,
});

use exports::langnext::runtime_plugin::llm_models::{Guest, ModelDescriptor, ModelsListRequest, ModelsListResponse};
use langnext::runtime_plugin::common::PluginError;
use langnext::runtime_plugin::host::{
    BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest, broker_fetch, is_cancelled,
};
use langnext_deepseek_protocol as protocol;

/// Map a host broker denial to a stable plugin error (never raw transport text).
fn broker_err(error: BrokerError) -> PluginError {
    match error {
        BrokerError::NotApproved => PluginError::PermissionDenied,
        BrokerError::Timeout => PluginError::Timeout,
        BrokerError::Cancelled => PluginError::Cancelled,
        BrokerError::Network(_) => PluginError::Network(String::from("broker network failure")),
        BrokerError::MethodNotAllowed | BrokerError::PathConfined | BrokerError::HeaderBlocked => {
            PluginError::InvalidRequest(String::from("broker request not approved"))
        }
        BrokerError::LimitExceeded => PluginError::InvalidResponse(String::from("broker response limit")),
        BrokerError::Internal(_) => PluginError::Internal(String::from("broker internal failure")),
    }
}

/// Map the bounded provider status classification to a stable plugin error. The provider
/// error body is never inspected (frontend executor behavior: status-only mapping).
fn status_err(error: protocol::ProviderStatusError) -> PluginError {
    match error {
        protocol::ProviderStatusError::Auth => PluginError::Auth,
        protocol::ProviderStatusError::RateLimited => PluginError::RateLimited,
        protocol::ProviderStatusError::Server => PluginError::ProviderUnavailable,
        protocol::ProviderStatusError::Client => PluginError::InvalidResponse(String::from("provider request failed")),
    }
}

/// Fetch the provider models endpoint through the host broker; returns the parsed model ids.
fn fetch_models() -> Result<Vec<String>, PluginError> {
    // The current provider plugin sends no headers for the models request; the host broker
    // defaults to the JSON response mode and injects the bearer credential.
    let response = broker_fetch(BrokerRequest {
        endpoint_id: String::from("provider-instance"),
        relative_path: String::from(protocol::MODELS_PATH),
        method: String::from("GET"),
        headers: vec![],
        body: BrokerBodyRequest::Empty,
    })
    .map_err(broker_err)?;
    if let Some(error) = protocol::provider_status_error(response.status) {
        return Err(status_err(error));
    }
    let bytes = match response.body {
        BrokerBodyResponse::Json(bytes) => bytes,
        _ => {
            return Err(PluginError::InvalidResponse(String::from(
                "models response is not json",
            )))
        }
    };
    protocol::parse_models_page(&bytes).map_err(|error| PluginError::InvalidResponse(error.0))
}

struct Component;

impl Guest for Component {
    fn models_list(
        _config: Vec<u8>,
        _request: ModelsListRequest,
    ) -> Result<ModelsListResponse, PluginError> {
        let _cancelled = is_cancelled();
        let models = fetch_models()?;
        // The current plugin projects ids only (no remote display names).
        Ok(ModelsListResponse {
            models: models
                .into_iter()
                .map(|id| ModelDescriptor { id, label: None })
                .collect(),
        })
    }
}

// --- Minimal no_std bump allocator (leaks; sufficient for a short-lived provider guest) ---
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
