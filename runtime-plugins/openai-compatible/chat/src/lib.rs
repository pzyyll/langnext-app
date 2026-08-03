// ABOUTME: OpenAI Compatible llm-chat-world Component: chat.completions unary + SSE streaming
// ABOUTME: through the host broker under the host-selected envelope. Bindings: generated.rs.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

include!("generated.rs");

use exports::langnext::runtime_plugin::llm_chat::{ChatMessage, ChatRequest, ChatResponse, ChatResult, Guest};
use langnext::runtime_plugin::common::{
    LlmCompletionStatus, LlmDelta, PluginError, ResourceError, StreamFrame, StreamWriter,
};
use langnext::runtime_plugin::host::{
    BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest, blob_length, blob_read,
    broker_fetch, is_cancelled, stream_finish, stream_receive, stream_send,
};
use langnext_openai_compatible_protocol as protocol;

/// Provider chat completions endpoint requested through the host broker (provider-instance auth).
const CHAT_PATH: &str = protocol::CHAT_COMPLETIONS_PATH;

/// Extract the `mode` value from copied config JSON bytes without a JSON dependency. Returns
/// `"fixed"` when absent so a bare invocation follows the host preference envelope.
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
                        b"complete-oversize" => "complete-oversize",
                        b"stream-oversize-delta" => "stream-oversize-delta",
                        b"stream-oversize-total" => "stream-oversize-total",
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

/// Map a host stream write failure to a stable plugin error (never raw resource text). A
/// `Cancelled` writer while the request is NOT user-cancelled means the host bridge failed the
/// stream (bounds breach); the guest reports it as an invalid response, never as a user cancel.
fn stream_err(error: ResourceError) -> PluginError {
    match error {
        ResourceError::Cancelled if is_cancelled() => PluginError::Cancelled,
        _ => PluginError::InvalidResponse(String::from("chat stream write failed")),
    }
}

/// Base64-encode the PNG bytes of every host-owned image Blob (bounded length + PNG magic).
fn image_base64s(request: &ChatRequest<'_>) -> Result<Vec<String>, PluginError> {
    if request.images.len() > protocol::MAX_CHAT_IMAGES {
        return Err(PluginError::InvalidInput(String::from(
            "openai-compatible chat supports at most one image",
        )));
    }
    let mut encoded = Vec::with_capacity(request.images.len());
    for &handle in &request.images {
        let length = blob_length(handle)
            .map_err(|_| PluginError::InvalidInput(String::from("chat image blob is not readable")))?;
        let head = blob_read(handle, 0, 4)
            .map_err(|_| PluginError::InvalidInput(String::from("chat image blob read failed")))?;
        protocol::validate_png_image(length, &head)
            .map_err(|error| PluginError::InvalidInput(error.0))?;
        let mut bytes = Vec::with_capacity(length as usize);
        let mut offset: u64 = 0;
        while offset < length {
            let chunk = blob_read(handle, offset, 4096)
                .map_err(|_| PluginError::InvalidInput(String::from("chat image blob read failed")))?;
            if chunk.is_empty() {
                return Err(PluginError::InvalidInput(String::from("chat image blob read is empty")));
            }
            let chunk_len = chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
            offset = offset.saturating_add(chunk_len);
        }
        encoded.push(protocol::base64_encode(&bytes));
    }
    Ok(encoded)
}

/// Build the provider chat body: copied semantic messages, the host-selected stream flag,
/// optional temperature/max_tokens from the preference envelope, and the image data URL.
fn build_body(request: &ChatRequest<'_>, preferences: &protocol::LlmPreferences) -> Result<Vec<u8>, PluginError> {
    let messages: Vec<(String, String)> = request
        .messages
        .iter()
        .map(|message| (message.role.clone(), message.content.clone()))
        .collect();
    let images = image_base64s(request)?;
    let image = images.first().map(String::as_str);
    let body = protocol::build_chat_completions(
        &request.model,
        &messages,
        preferences.temperature,
        preferences.max_tokens,
        image,
        preferences.stream,
    );
    Ok(body.into_bytes())
}

/// Fetch the provider chat endpoint for a non-stream request and parse the complete message.
fn fetch_complete(request: &ChatRequest<'_>, preferences: &protocol::LlmPreferences) -> Result<ChatResponse, PluginError> {
    let body = build_body(request, preferences)?;
    let response = broker_fetch(BrokerRequest {
        endpoint_id: String::from("provider-instance"),
        relative_path: String::from(CHAT_PATH),
        method: String::from("POST"),
        headers: vec![(String::from("Content-Type"), String::from("application/json"))],
        body: BrokerBodyRequest::Json(body),
    })
    .map_err(broker_err)?;
    if let Some(error) = protocol::provider_status_error(response.status) {
        return Err(status_err(error));
    }
    let bytes = match response.body {
        BrokerBodyResponse::Json(bytes) => bytes,
        _ => {
            return Err(PluginError::InvalidResponse(String::from(
                "chat response is not json",
            )))
        }
    };
    let content = protocol::parse_chat_content(&bytes).map_err(|error| PluginError::InvalidResponse(error.0))?;
    Ok(ChatResponse {
        message: ChatMessage {
            role: String::from("assistant"),
            content,
        },
    })
}

/// Fetch the provider SSE stream through the broker (`Accept: text/event-stream` selects the
/// host stream response mode) and write ordered text deltas to the output writer. `[DONE]`
/// terminates the stream with one `complete` frame; a malformed event fails closed.
fn fetch_and_stream(
    request: &ChatRequest<'_>,
    preferences: &protocol::LlmPreferences,
    output: StreamWriter,
) -> Result<ChatResult, PluginError> {
    let body = build_body(request, preferences)?;
    let response = broker_fetch(BrokerRequest {
        endpoint_id: String::from("provider-instance"),
        relative_path: String::from(CHAT_PATH),
        method: String::from("POST"),
        headers: vec![
            (String::from("Content-Type"), String::from("application/json")),
            (String::from("Accept"), String::from("text/event-stream")),
        ],
        body: BrokerBodyRequest::Json(body),
    })
    .map_err(broker_err)?;
    if let Some(error) = protocol::provider_status_error(response.status) {
        return Err(status_err(error));
    }
    let reader = match response.body {
        BrokerBodyResponse::Stream(reader) => reader,
        _ => {
            return Err(PluginError::InvalidResponse(String::from(
                "chat response is not a stream",
            )))
        }
    };
    let mut decoder = protocol::SseDecoder::new();
    let mut done = false;
    loop {
        match stream_receive(&reader).map_err(|_| PluginError::InvalidResponse(String::from("chat stream read failed")))? {
            Some(StreamFrame::NetworkBinary(bytes)) => {
                for event in decoder.feed(&bytes) {
                    match protocol::parse_stream_event_data(&event) {
                        Ok(Some(text)) => {
                            stream_send(&output, &StreamFrame::LlmDelta(LlmDelta::Text(text))).map_err(stream_err)?;
                        }
                        Ok(None) => {
                            // `[DONE]`: one terminal complete frame, then seal the writer.
                            done = true;
                        }
                        Err(error) => return Err(PluginError::InvalidResponse(error.0)),
                    }
                }
            }
            Some(StreamFrame::Terminal(_)) => break,
            _ => break,
        }
    }
    if !done {
        return Err(PluginError::InvalidResponse(String::from(
            "chat stream ended without a done event",
        )));
    }
    stream_send(
        &output,
        &StreamFrame::LlmDelta(LlmDelta::Complete(LlmCompletionStatus::Stop)),
    )
    .map_err(stream_err)?;
    stream_finish(output).map_err(stream_err)?;
    Ok(ChatResult::Streaming)
}

/// Build a bounded ASCII string of `count` `x` bytes (fixture oversized content).
fn x_fill(count: usize) -> Result<String, PluginError> {
    String::from_utf8(vec![b'x'; count])
        .map_err(|_| PluginError::Internal(String::from("fixture content build failed")))
}

struct Component;

impl Guest for Component {
    fn chat(
        config: Vec<u8>,
        request: ChatRequest<'_>,
        output: StreamWriter,
    ) -> Result<ChatResult, PluginError> {
        let _cancelled = is_cancelled();
        let preferences = protocol::parse_preferences(&request.preferences)
            .map_err(|_error| PluginError::InvalidConfiguration)?;
        match mode(&config) {
            // Host-bound verification modes: the guest synthesizes an oversized complete
            // message or stream deltas; the host rejects them at its named limits.
            "complete-oversize" => Ok(ChatResult::Complete(ChatResponse {
                message: ChatMessage {
                    role: String::from("assistant"),
                    content: x_fill(256 * 1024 + 1)?,
                },
            })),
            "stream-oversize-delta" => {
                stream_send(
                    &output,
                    &StreamFrame::LlmDelta(LlmDelta::Text(x_fill(64 * 1024 + 1)?)),
                )
                .map_err(stream_err)?;
                stream_finish(output).map_err(stream_err)?;
                Ok(ChatResult::Streaming)
            }
            "stream-oversize-total" => {
                const DELTA_BYTES: usize = 64 * 1024;
                for _ in 0..40 {
                    if let Err(error) = stream_send(
                        &output,
                        &StreamFrame::LlmDelta(LlmDelta::Text(x_fill(DELTA_BYTES)?)),
                    ) {
                        return Err(stream_err(error));
                    }
                }
                stream_finish(output).map_err(stream_err)?;
                Ok(ChatResult::Streaming)
            }
            _ => {
                // The host selects the mode: complete for stream = false, SSE stream deltas
                // for stream = true. The guest never infers the mode from protocol details.
                if preferences.stream {
                    fetch_and_stream(&request, &preferences, output)
                } else {
                    Ok(ChatResult::Complete(fetch_complete(&request, &preferences)?))
                }
            }
        }
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
