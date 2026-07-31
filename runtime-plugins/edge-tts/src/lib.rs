// ABOUTME: Edge TTS Wasm guest targeting speech-synthesize-world.
// ABOUTME: Builds an OpenAI-compatible /v1/audio/speech request over host.broker and returns a host blob-handle.
#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;

// `std_feature` keeps generated bindings no_std unless the optional empty `std` feature is enabled.
wit_bindgen::generate!({
  path: "../../src-tauri/wit/runtime-plugin",
  world: "speech-synthesize-world",
  std_feature,
});

use exports::langnext::runtime_plugin::speech_synthesize::{
    Guest, SynthesizeRequest, SynthesizeResponse,
};
use langnext::runtime_plugin::common::{MediaMetadata, PluginError};
use langnext::runtime_plugin::host::{
    blob_discard, blob_length, blob_metadata, broker_fetch, is_cancelled, BrokerBodyRequest,
    BrokerBodyResponse, BrokerError, BrokerRequest, ResourceError,
};

/// Manifest endpoint alias for the instance-scoped OpenAI-compatible TTS base URL (host grant resolves the origin).
const TTS_ENDPOINT: &str = "tts-api";
/// Relative path appended to the configured base URL for synthesis.
const SYNTHESIZE_PATH: &str = "v1/audio/speech";
/// Bounded MP3 response cap (mirrors host `SPEECH_AUDIO_MAX_BYTES` = 12 MiB).
const MAX_AUDIO_BYTES: u64 = 12 * 1024 * 1024;

/// Edge TTS runtime preferences (schema v1). Mirrors host `EdgeTtsPreferences`; unknown fields are
/// ignored so a forward-compatible host preference payload does not fail synthesis.
#[derive(serde::Deserialize)]
struct EdgeTtsPreferences {
    #[serde(default = "default_voice")]
    voice: String,
    #[serde(default = "default_speed")]
    speed: f64,
    #[serde(default = "default_pitch")]
    pitch: f64,
    #[serde(default = "default_style")]
    style: String,
}

fn default_voice() -> String {
    String::from("zh-CN-XiaoxiaoNeural")
}
fn default_speed() -> f64 {
    1.0
}
fn default_pitch() -> f64 {
    0.0
}
fn default_style() -> String {
    String::from("general")
}

/// OpenAI-compatible synthesis request body. `pitch` is a string scalar ("-50".."50") to match the
/// existing Rust transport; `f64::to_string` strips trailing zeros.
#[derive(serde::Serialize)]
struct SynthesizeBody<'a> {
    input: &'a str,
    voice: &'a str,
    speed: f64,
    pitch: String,
    style: &'a str,
}

struct Component;

impl Guest for Component {
    fn synthesize(
        config: Vec<u8>,
        request: SynthesizeRequest,
    ) -> Result<SynthesizeResponse, PluginError> {
        // The base URL is stored in config but the origin is host-resolved via the grant; the guest only
        // uses the endpoint alias. Validate config is a JSON object (or empty for defaults).
        parse_config(&config)?;

        if is_cancelled() {
            return Err(PluginError::Cancelled);
        }

        let preferences: EdgeTtsPreferences = serde_json::from_slice(&request.preferences)
            .map_err(|_| PluginError::InvalidInput(String::from("invalid Edge TTS preferences")))?;

        let body = SynthesizeBody {
            input: &request.text,
            voice: &preferences.voice,
            speed: preferences.speed,
            pitch: preferences.pitch.to_string(),
            style: &preferences.style,
        };
        let body_bytes = serde_json::to_vec(&body).map_err(|_| {
            PluginError::Internal(String::from("failed to serialize synthesis body"))
        })?;

        let mut headers: Vec<(String, String)> = Vec::new();
        headers.push((String::from("Accept"), String::from("audio/mpeg")));
        let broker_request = BrokerRequest {
            endpoint_id: String::from(TTS_ENDPOINT),
            relative_path: String::from(SYNTHESIZE_PATH),
            method: String::from("POST"),
            headers,
            body: BrokerBodyRequest::Json(body_bytes),
        };
        let response = broker_fetch(broker_request).map_err(map_broker_error)?;

        if !(200..300).contains(&response.status) {
            // Discard any blob body so the host-owned handle is not leaked on error.
            if let BrokerBodyResponse::Blob(handle) = response.body {
                blob_discard(handle);
            }
            return Err(map_http_error(response.status));
        }

        let handle = match response.body {
            BrokerBodyResponse::Blob(handle) => handle,
            _ => {
                return Err(PluginError::InvalidResponse(String::from(
                    "expected blob body for synthesis audio",
                )))
            }
        };

        let length = blob_length(&handle).map_err(map_resource_error)?;
        if length == 0 {
            blob_discard(handle);
            return Err(PluginError::InvalidResponse(String::from(
                "Edge TTS returned empty audio",
            )));
        }
        if length > MAX_AUDIO_BYTES {
            blob_discard(handle);
            return Err(PluginError::InvalidResponse(String::from(
                "Edge TTS audio exceeds size limit",
            )));
        }

        // Content-type is metadata only (MIME may be spoofed); the host enforces the provider contract.
        let media: MediaMetadata = blob_metadata(&handle).map_err(map_resource_error)?;
        Ok(SynthesizeResponse {
            output: handle,
            media,
        })
    }
}

/// Validate config JSON is an object (or empty for defaults). The base URL origin is host-resolved.
fn parse_config(config: &[u8]) -> Result<(), PluginError> {
    if config.is_empty() {
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_slice(config).map_err(|_| PluginError::InvalidConfiguration)?;
    if !value.is_object() {
        return Err(PluginError::InvalidConfiguration);
    }
    Ok(())
}

/// Map HTTP status to stable plugin-error variants (mirrors host `map_edge_tts_http_error`).
fn map_http_error(status: u16) -> PluginError {
    match status {
        400 => PluginError::InvalidRequest(String::from("Edge TTS rejected the request")),
        401 | 403 => PluginError::PermissionDenied,
        429 => PluginError::RateLimited,
        _ => PluginError::ProviderUnavailable,
    }
}

/// Map broker errors to stable plugin-error variants.
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

/// Map blob resource errors to stable plugin-error variants.
fn map_resource_error(error: ResourceError) -> PluginError {
    match error {
        ResourceError::NotOwned => PluginError::Internal(String::from("blob not owned")),
        ResourceError::WrongDirection => {
            PluginError::Internal(String::from("blob wrong direction"))
        }
        ResourceError::Exhausted => PluginError::InvalidResponse(String::from("blob exhausted")),
        ResourceError::OutOfBounds => {
            PluginError::InvalidResponse(String::from("blob out of bounds"))
        }
        ResourceError::Closed => PluginError::InvalidResponse(String::from("blob closed")),
        ResourceError::Cancelled => PluginError::Cancelled,
        ResourceError::Internal(msg) => PluginError::Internal(msg),
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
