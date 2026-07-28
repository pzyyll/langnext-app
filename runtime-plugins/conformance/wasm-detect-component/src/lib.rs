// ABOUTME: Synthetic Wasm Component guest for the translate-detect-world conformance suite.
// ABOUTME: no_std; imports only common and host. Exports translate.detect@1.
// Selects behavior via the `mode` field of the copied config JSON.
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

/// Valid confidence returned by the success path (within the host-accepted [0, 1] range).
const SUCCESS_CONFIDENCE: f32 = 0.95;
/// Out-of-range confidence used by `invalid-confidence` mode so the host rejects the response.
const INVALID_CONFIDENCE: f32 = 2.0;

/// Extract the `mode` value from copied config JSON bytes without a JSON dependency.
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
                        b"failure" => "failure",
                        b"invalid-confidence" => "invalid-confidence",
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

/// Extract a JSON string value for a key without a full parser.
fn extract_json_string(bytes: &[u8], key: &[u8]) -> Option<String> {
    let mut i = 0;
    while i + key.len() <= bytes.len() {
        if &bytes[i..i + key.len()] == key {
            let rest = &bytes[i + key.len()..];
            if let Some(start) = rest.iter().position(|b| *b == b'"') {
                let after = &rest[start + 1..];
                if let Some(end) = after.iter().position(|b| *b == b'"') {
                    return String::from_utf8(after[..end].to_vec()).ok();
                }
            }
        }
        i += 1;
    }
    None
}

impl Guest for Component {
    fn detect(
        config: Vec<u8>,
        preferences: Vec<u8>,
        _request: DetectRequest,
    ) -> Result<DetectResponse, PluginError> {
        match mode(&config) {
            "success" => {
                // Prefer explicit `language` preference when present so host E2E can observe prefs
                // without breaking language-id validation.
                let language_id = extract_json_string(&preferences, b"\"language\"")
                    .unwrap_or_else(|| String::from("en"));
                let confidence = if preferences_nonempty(&preferences) {
                    // Distinct from the empty-prefs path so hosts can assert prefs were received.
                    Some(0.91)
                } else {
                    Some(SUCCESS_CONFIDENCE)
                };
                Ok(DetectResponse {
                    language_id,
                    confidence,
                })
            }
            "failure" => Err(PluginError::UnsupportedLanguage(String::from(
                "conformance failure mode",
            ))),
            "invalid-confidence" => Ok(DetectResponse {
                language_id: String::from("en"),
                confidence: Some(INVALID_CONFIDENCE),
            }),
            _ => Ok(DetectResponse {
                language_id: String::from("en"),
                confidence: Some(SUCCESS_CONFIDENCE),
            }),
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
