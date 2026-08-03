// ABOUTME: Synthetic Wasm Component guest for the llm-chat-world conformance suite.
// ABOUTME: no_std; imports only common and host; complete/error/oversize/stream/cancel modes.
#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

include!("generated.rs");

use exports::langnext::runtime_plugin::llm_chat::{ChatMessage, ChatRequest, ChatResponse, ChatResult, Guest};
use langnext::runtime_plugin::common::{
    LlmCompletionStatus, LlmDelta, LlmToolCallDelta, PluginError, ResourceError, StreamFrame,
};
use langnext::runtime_plugin::host::{
    BrokerBodyRequest, BrokerBodyResponse, BrokerError, BrokerRequest, StreamWriter, blob_length,
    blob_read, broker_fetch, is_cancelled, stream_finish, stream_send,
};

/// Fixed provider chat endpoint requested through the host broker (provider-instance auth).
const CHAT_PATH: &str = "chat";

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
                        b"complete-oversize" => "complete-oversize",
                        b"guest-error" => "guest-error",
                        b"malformed" => "malformed",
                        b"unexpected-stream" => "unexpected-stream",
                        b"stream-fixed" => "stream-fixed",
                        b"stream-oversize-delta" => "stream-oversize-delta",
                        b"stream-oversize-total" => "stream-oversize-total",
                        b"stream-block" => "stream-block",
                        _ => "fixed",
                    };
                }
            }
        }
        i += 1;
    }
    "fixed"
}

/// Read the host-owned `stream` flag from the copied `LlmChatPreferencesV1` envelope JSON
/// (`{"stream":false,"temperature":...,"maxTokens":...,"thinking":...}`). The host selects the
/// mode; the guest never infers or overrides it from provider protocol details.
fn preference_stream(preferences: &[u8]) -> bool {
    let needle = b"\"stream\"";
    let mut i = 0;
    while i + needle.len() <= preferences.len() {
        if &preferences[i..i + needle.len()] == needle {
            let rest = &preferences[i + needle.len()..];
            if let Some(pos) = rest.iter().position(|b| *b == b':') {
                let value = &rest[pos + 1..];
                if value.starts_with(b"true") {
                    return true;
                }
                if value.starts_with(b"false") {
                    return false;
                }
            }
        }
        i += 1;
    }
    false
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

/// Map a host stream write failure to a stable plugin error (never raw resource text). A
/// `Cancelled` writer while the request is NOT user-cancelled means the host bridge failed the
/// stream (bounds breach); the guest reports it as an invalid response, never as a user cancel.
fn stream_err(error: ResourceError) -> PluginError {
    match error {
        ResourceError::Cancelled if is_cancelled() => PluginError::Cancelled,
        _ => PluginError::InvalidResponse(String::from("chat stream write failed")),
    }
}

/// Fixed-mode provider request: model, semantic messages, the host preference envelope's
/// stream flag, and ONLY the image byte count — image bytes stay in host-owned Blobs.
fn build_chat_body(model: &str, messages: &[ChatMessage], stream: bool, image_bytes: u64) -> Vec<u8> {
    let mut body = alloc::string::String::from("{\"image_bytes\":");
    body.push_str(&image_bytes.to_string());
    body.push_str(",\"messages\":[");
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str("{\"content\":");
        push_json_string(&mut body, &message.content);
        body.push_str(",\"role\":");
        push_json_string(&mut body, &message.role);
        body.push('}');
    }
    body.push_str("],\"model\":");
    push_json_string(&mut body, model);
    body.push_str(",\"preference_stream\":");
    body.push_str(if stream { "true" } else { "false" });
    body.push('}');
    body.into_bytes()
}

/// Minimal JSON string escaping for fixed conformance messages (ASCII fixture content).
fn push_json_string(out: &mut alloc::string::String, value: &str) {
    out.push('"');
    for byte in value.bytes() {
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            _ => out.push(byte as char),
        }
    }
    out.push('"');
}

/// Parse the fixed provider chat JSON body: `{"message":{"role":...,"content":...}}`.
fn parse_chat_response(body: &[u8]) -> Result<ChatResponse, PluginError> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| PluginError::InvalidResponse(String::from("chat body is not valid json")))?;
    let message = value
        .get("message")
        .ok_or_else(|| PluginError::InvalidResponse(String::from("chat body has no message")))?;
    let role = message
        .get("role")
        .and_then(|role| role.as_str())
        .ok_or_else(|| PluginError::InvalidResponse(String::from("chat message has no role")))?;
    let content = message
        .get("content")
        .and_then(|content| content.as_str())
        .ok_or_else(|| PluginError::InvalidResponse(String::from("chat message has no content")))?;
    Ok(ChatResponse {
        message: ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        },
    })
}

/// Fetch the fixed provider chat endpoint; returns the raw response body.
fn fetch_chat_fixture() -> Result<Vec<u8>, PluginError> {
    let response = broker_fetch(BrokerRequest {
        endpoint_id: String::from("provider-instance"),
        relative_path: String::from(CHAT_PATH),
        method: String::from("POST"),
        headers: vec![(String::from("Accept"), String::from("application/json"))],
        body: BrokerBodyRequest::Empty,
    })
    .map_err(broker_err)?;
    match response.body {
        BrokerBodyResponse::Json(bytes) => Ok(bytes),
        _ => Err(PluginError::InvalidResponse(String::from(
            "chat response is not json",
        ))),
    }
}

/// Host-owned image Blobs: every borrowed handle must be a readable PNG of bounded size; the
/// guest reports only the aggregate byte count in the provider request (never image bytes).
fn total_image_bytes(request: &ChatRequest<'_>) -> Result<u64, PluginError> {
    let mut total: u64 = 0;
    for &handle in &request.images {
        let length = blob_length(handle)
            .map_err(|_| PluginError::InvalidInput(String::from("chat image blob is not readable")))?;
        if length == 0 || length > 10 * 1024 * 1024 {
            return Err(PluginError::InvalidInput(String::from("chat image blob length is out of bounds")));
        }
        let head = blob_read(handle, 0, 4)
            .map_err(|_| PluginError::InvalidInput(String::from("chat image blob read failed")))?;
        if head != [0x89, 0x50, 0x4e, 0x47] {
            return Err(PluginError::InvalidInput(String::from("chat image blob is not a png")));
        }
        total = total.saturating_add(length);
    }
    Ok(total)
}

/// Write one typed delta frame through the host-owned writer (the host enforces bounds).
fn send_delta(writer: &StreamWriter, delta: LlmDelta) -> Result<(), PluginError> {
    stream_send(writer, &StreamFrame::LlmDelta(delta)).map_err(stream_err)
}

/// Streaming fixture: ordered text/reasoning/tool/complete deltas, exactly one terminal
/// transition, then `stream-finish` and a `streaming` result.
fn stream_fixed(writer: StreamWriter) -> Result<ChatResult, PluginError> {
    send_delta(&writer, LlmDelta::Text(String::from("Hello")))?;
    send_delta(&writer, LlmDelta::Reasoning(String::from("step one")))?;
    send_delta(
        &writer,
        LlmDelta::ToolCall(LlmToolCallDelta {
            id: String::from("call-1"),
            name: String::from("search"),
            arguments_json: br#"{"q":"rust"}"#.to_vec(),
        }),
    )?;
    send_delta(&writer, LlmDelta::Text(String::from(" world")))?;
    send_delta(&writer, LlmDelta::Complete(LlmCompletionStatus::Stop))?;
    stream_finish(writer).map_err(stream_err)?;
    Ok(ChatResult::Streaming)
}

/// Build a bounded ASCII string of `count` `x` bytes (fixture oversized content).
fn x_fill(count: usize) -> Result<String, PluginError> {
    String::from_utf8(vec![b'x'; count])
        .map_err(|_| PluginError::Internal(String::from("fixture content build failed")))
}

/// Streaming oversize modes: a single oversized text delta, or repeated deltas whose
/// cumulative output exceeds the host total-output bound. The host fails the stream; the
/// guest maps write failures to a stable plugin error.
fn stream_oversize(writer: StreamWriter, total_mode: bool) -> Result<ChatResult, PluginError> {
    const DELTA_BYTES: usize = 64 * 1024;
    if total_mode {
        for _ in 0..40 {
            if let Err(error) = stream_send(
                &writer,
                &StreamFrame::LlmDelta(LlmDelta::Text(x_fill(DELTA_BYTES)?)),
            ) {
                return Err(stream_err(error));
            }
        }
    } else {
        stream_send(&writer, &StreamFrame::LlmDelta(LlmDelta::Text(x_fill(DELTA_BYTES + 1)?)))
            .map_err(stream_err)?;
    }
    stream_finish(writer).map_err(stream_err)?;
    Ok(ChatResult::Streaming)
}

struct Component;

impl Guest for Component {
    fn chat(
        config: Vec<u8>,
        request: ChatRequest<'_>,
        output: StreamWriter,
    ) -> Result<ChatResult, PluginError> {
        let _cancelled = is_cancelled();
        let stream = preference_stream(&request.preferences);
        match mode(&config) {
            // Task 7: complete/error/oversize modes under the host-selected non-stream envelope.
            "complete-oversize" => {
                // Host must reject a complete message beyond its named bound.
                Ok(ChatResult::Complete(ChatResponse {
                    message: ChatMessage {
                        role: String::from("assistant"),
                        content: x_fill(256 * 1024 + 1)?,
                    },
                }))
            }
            "guest-error" => Err(PluginError::InvalidResponse(String::from("fixture chat guest error"))),
            "malformed" => {
                // The capture transport returns a malformed body; the guest maps it fail-closed.
                let _body = fetch_chat_fixture()?;
                Err(PluginError::InvalidResponse(String::from(
                    "chat body is not valid json",
                )))
            }
            "unexpected-stream" => {
                // Host must reject a streaming result under a non-stream preference.
                Ok(ChatResult::Streaming)
            }
            // Task 8: streaming/cancel/oversize modes under the host-selected stream envelope.
            "stream-fixed" => {
                let _fixture = fetch_chat_fixture()?;
                stream_fixed(output)
            }
            "stream-oversize-delta" => {
                let _fixture = fetch_chat_fixture()?;
                stream_oversize(output, false)
            }
            "stream-oversize-total" => {
                let _fixture = fetch_chat_fixture()?;
                stream_oversize(output, true)
            }
            "stream-block" => {
                // Broker call blocks on the capture transport; the host cancels it.
                let _fixture = fetch_chat_fixture()?;
                stream_fixed(output)
            }
            _ => {
                // Fixed mode: the guest deterministically completes for stream = false. It
                // reports the preference envelope's stream flag and only image byte counts.
                if stream {
                    return Err(PluginError::InvalidResponse(String::from(
                        "fixture fixed mode requires a non-stream preference",
                    )));
                }
                let image_bytes = total_image_bytes(&request)?;
                let body = build_chat_body(&request.model, &request.messages, stream, image_bytes);
                let response = broker_fetch(BrokerRequest {
                    endpoint_id: String::from("provider-instance"),
                    relative_path: String::from(CHAT_PATH),
                    method: String::from("POST"),
                    headers: vec![
                        (String::from("Accept"), String::from("application/json")),
                        (String::from("Content-Type"), String::from("application/json")),
                    ],
                    body: BrokerBodyRequest::Json(body),
                })
                .map_err(broker_err)?;
                let body = match response.body {
                    BrokerBodyResponse::Json(bytes) => bytes,
                    _ => {
                        return Err(PluginError::InvalidResponse(String::from(
                            "chat response is not json",
                        )))
                    }
                };
                Ok(ChatResult::Complete(parse_chat_response(&body)?))
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
