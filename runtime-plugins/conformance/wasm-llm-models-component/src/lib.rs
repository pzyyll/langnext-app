// ABOUTME: Synthetic Wasm Component guest for the llm-models-world conformance suite.
// ABOUTME: no_std; imports only common and host. Task 6 adds fixed/duplicates/over-limit modes.
#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
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
    broker_fetch, is_cancelled, BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest,
};

/// Fixed provider models endpoint requested through the host broker (provider-instance auth).
const MODELS_PATH: &str = "models";

/// Extract the `mode` value from copied config JSON bytes without a JSON dependency. Returns
/// `"fixed"` when absent so a bare invocation fetches the fixed provider fixture.
fn mode(config: &[u8]) -> &'static str {
    let needle = b"\"mode\"";
    let mut i = 0;
    while i + needle.len() <= config.len() {
        if &config[i..i + needle.len()] == needle {
            let rest = &config[i + needle.len()..];
            if let Some(start) = rest.iter().position(|b| *b == b'"') {
                let after = &rest[start + 1..];
                if let Some(end) = after.iter().position(|b| *b == b'"') {
                    return match &after[..end] {
                        b"duplicates" => "duplicates",
                        b"over-limit" => "over-limit",
                        _ => "fixed",
                    };
                }
            }
        }
        i += 1;
    }
    "fixed"
}

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

/// Parse the fixed provider `/models` JSON body: `{"data":[{"id":...,"label":...},...]}`.
/// The host fixture is committed and deterministic; the guest never sees credentials or URLs.
fn parse_models_body(body: &[u8]) -> Result<Vec<ModelDescriptor>, PluginError> {
    let text = core::str::from_utf8(body)
        .map_err(|_| PluginError::InvalidResponse(String::from("models body is not utf-8")))?;
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| PluginError::InvalidResponse(String::from("models body is not valid json")))?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| PluginError::InvalidResponse(String::from("models body has no data array")))?;
    let mut models = Vec::with_capacity(data.len().min(1024));
    for entry in data {
        let id = entry
            .get("id")
            .and_then(|id| id.as_str())
            .ok_or_else(|| PluginError::InvalidResponse(String::from("model entry has no id")))?;
        let label = entry.get("label").and_then(|label| label.as_str());
        models.push(ModelDescriptor {
            id: id.to_string(),
            label: label.map(ToString::to_string),
        });
    }
    Ok(models)
}

struct Component;

impl Guest for Component {
    fn models_list(
        config: Vec<u8>,
        _request: ModelsListRequest,
    ) -> Result<ModelsListResponse, PluginError> {
        let _cancelled = is_cancelled();
        match mode(&config) {
            "duplicates" => {
                // Host must reject duplicate descriptors in one aggregate list.
                Ok(ModelsListResponse {
                    models: vec![
                        ModelDescriptor {
                            id: String::from("gpt-4o"),
                            label: Some(String::from("GPT-4o")),
                        },
                        ModelDescriptor {
                            id: String::from("gpt-4o"),
                            label: Some(String::from("GPT-4o")),
                        },
                    ],
                })
            }
            "over-limit" => {
                // Host must reject an aggregate exceeding its named maximum model count.
                let mut models = Vec::with_capacity(600);
                for i in 0..600u32 {
                    models.push(ModelDescriptor {
                        id: alloc::format!("over-limit-model-{i}"),
                        label: None,
                    });
                }
                Ok(ModelsListResponse { models })
            }
            _ => {
                // Fixed mode: fetch the provider models endpoint through the host broker.
                let response = broker_fetch(BrokerRequest {
                    endpoint_id: String::from("provider-instance"),
                    relative_path: String::from(MODELS_PATH),
                    method: String::from("GET"),
                    headers: vec![(String::from("Accept"), String::from("application/json"))],
                    body: BrokerBodyRequest::Empty,
                })
                .map_err(broker_err)?;
                let body = match response.body {
                    BrokerBodyResponse::Json(bytes) => bytes,
                    _ => {
                        return Err(PluginError::InvalidResponse(String::from(
                            "models response is not json",
                        )))
                    }
                };
                Ok(ModelsListResponse {
                    models: parse_models_body(&body)?,
                })
            }
        }
    }
}

// --- Minimal no_std bump allocator (leaks; sufficient for a short-lived conformance guest) ---
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
