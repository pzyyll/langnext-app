// ABOUTME: Synthetic Wasm Component guest for the Phase 2 runtime conformance suite.
// ABOUTME: Targets `translate-text-world`; selects behavior via the config `mode` field.
// `no_std` so the component imports only `common` and `host` (never WASI).
#![no_std]

extern crate alloc;

use alloc::format;
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

/// Character count for `oversized-output` mode: 1 MiB of `x` to exceed host response bounds.
const OVERSIZED_OUTPUT_CHARS: usize = 1024 * 1024;
/// Wasm pages requested by `memory-growth` mode (65536 pages = 4 GiB) to exceed StoreLimits.
const MEMORY_GROW_PAGES: usize = 65536;

/// Extract the `mode` value from copied config JSON bytes without a JSON dependency. Returns
/// `"success"` when absent so a bare invocation is well-defined.
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
                        b"success" => "success",
                        b"broker-call" => "broker-call",
                        b"denied-endpoint" => "denied-endpoint",
                        b"trap" => "trap",
                        b"infinite-loop" => "infinite-loop",
                        b"oversized-output" => "oversized-output",
                        b"slow-host-call" => "slow-host-call",
                        b"cancellation" => "cancellation",
                        b"memory-growth" => "memory-growth",
                        _ => "success",
                    };
                }
            }
        }
        i += 1;
    }
    "success"
}

struct Component;

/// True when preferences are a non-empty JSON object (not `{}` / blank).
fn preferences_nonempty(preferences: &[u8]) -> bool {
    let trimmed = core::str::from_utf8(preferences)
        .unwrap_or("")
        .trim();
    !(trimmed.is_empty() || trimmed == "{}")
}

impl Guest for Component {
    fn text(
        config: Vec<u8>,
        preferences: Vec<u8>,
        request: TextRequest,
    ) -> Result<TextResponse, PluginError> {
        match mode(&config) {
            "success" => {
                let translated_text = if preferences_nonempty(&preferences) {
                    // Surface exact preference JSON so host E2E can assert migrated prefs.
                    let prefs = String::from_utf8_lossy(&preferences);
                    format!("[{}]|prefs:{prefs}", request.text)
                } else {
                    format!("[{}]", request.text)
                };
                Ok(TextResponse {
                    translated_text,
                    detected_source_language_id: None,
                })
            }
            "broker-call" => {
                let resp = do_broker_fetch("approved", "GET").map_err(broker_err)?;
                let translated = match resp.body {
                    BrokerBodyResponse::Json(bytes) => String::from_utf8(bytes).map_err(|_| {
                        PluginError::InvalidResponse(String::from("non-utf8 broker body"))
                    })?,
                    _ => {
                        return Err(PluginError::InvalidResponse(String::from(
                            "expected json body",
                        )))
                    }
                };
                Ok(TextResponse {
                    translated_text: translated,
                    detected_source_language_id: None,
                })
            }
            "denied-endpoint" => match do_broker_fetch("denied", "GET") {
                Ok(_) => Err(PluginError::PermissionDenied),
                Err(BrokerError::NotApproved) => Err(PluginError::PermissionDenied),
                Err(_) => Err(PluginError::Internal(String::from(
                    "unexpected broker error",
                ))),
            },
            "trap" => {
                // Deliberately trap the guest; the host maps this to a sanitized plugin-unavailable error.
                #[cfg(target_arch = "wasm32")]
                core::arch::wasm32::unreachable();
                #[cfg(not(target_arch = "wasm32"))]
                unreachable!("conformance trap mode")
            }
            "infinite-loop" => {
                // Burn fuel/epoch until the host interrupts. Never returns.
                let mut x: u64 = 0;
                loop {
                    x = x.wrapping_add(1);
                    core::hint::spin_loop();
                }
            }
            "oversized-output" => {
                // Return translated text exceeding the host response bound; the host rejects it.
                let huge = String::from("x").repeat(OVERSIZED_OUTPUT_CHARS);
                Ok(TextResponse {
                    translated_text: huge,
                    detected_source_language_id: None,
                })
            }
            "slow-host-call" => {
                // The host broker sleeps past the deadline; the host times the call out.
                let _ = do_broker_fetch("slow", "GET").map_err(broker_err)?;
                Ok(TextResponse {
                    translated_text: String::from("slow"),
                    detected_source_language_id: None,
                })
            }
            "cancellation" => {
                // The host broker waits for cancellation; the host cancels the call.
                let _ = do_broker_fetch("wait-cancel", "GET").map_err(broker_err)?;
                Ok(TextResponse {
                    translated_text: String::from("cancelled-flow"),
                    detected_source_language_id: None,
                })
            }
            "memory-growth" => {
                // Use wasm memory.grow to exceed STORE_MEMORY_MAX_BYTES (16 MiB = 256 pages).
                // This hits Wasmtime's StoreLimits directly, not the guest's bump allocator.
                // With trap_on_grow_failure=true, the grow traps with MemoryOutOfBounds.
                // Request MEMORY_GROW_PAGES (4 GiB) to guarantee it exceeds any reasonable limit.
                // The result is used to prevent the optimizer from eliminating the call.
                let grown = core::arch::wasm32::memory_grow(0, MEMORY_GROW_PAGES);
                if grown == usize::MAX {
                    return Err(PluginError::Internal(String::from("memory growth failed")));
                }
                Err(PluginError::Internal(String::from(
                    "memory growth unexpectedly succeeded",
                )))
            }
            _ => Ok(TextResponse {
                translated_text: format!("[{}]", request.text),
                detected_source_language_id: None,
            }),
        }
    }
}

/// Build a broker request and fetch it, returning the response or broker error.
fn do_broker_fetch(endpoint: &str, method: &str) -> Result<BrokerResponse, BrokerError> {
    let request = BrokerRequest {
        endpoint_id: String::from(endpoint),
        relative_path: String::from("v1/conformance"),
        method: String::from(method),
        headers: Vec::new(),
        body: BrokerBodyRequest::Empty,
    };
    broker_fetch(request)
}

/// Map a broker error to a plugin error for modes that propagate failure.
fn broker_err(error: BrokerError) -> PluginError {
    match error {
        BrokerError::NotApproved => PluginError::PermissionDenied,
        BrokerError::Timeout => PluginError::Timeout,
        BrokerError::Cancelled => PluginError::Cancelled,
        BrokerError::Network(msg) => PluginError::Network(msg),
        _ => PluginError::Internal(String::from("broker error")),
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
                // Out of memory: trap the guest instead of returning null (avoids the unstable
                // `alloc_error_handler` on stable no_std). The host maps traps to a sanitized error.
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
