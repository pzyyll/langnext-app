// ABOUTME: Baidu OCR Wasm guest that reads a host Blob and sends a fixed form through the broker.
// ABOUTME: Credentials, token exchange, URL authority, network transport, and cancellation stay host-owned.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "ocr-image-world",
  std_feature,
});

use exports::langnext::runtime_plugin::ocr_image::{Guest, ImageRequest, ImageResponse};
use langnext::runtime_plugin::common::{BlobDirection, BlobHandle, PluginError};
use langnext::runtime_plugin::host::{
    blob_create, blob_length, blob_read, blob_write, broker_fetch, BrokerBodyRequest,
    BrokerBodyResponse, BrokerError, BrokerRequest, BrokerResponse, ResourceError,
};
use langnext_baidu_ocr_protocol as protocol;

const ACCEPT_JSON: &str = "application/json";
const BLOB_READ_CHUNK_BYTES: u64 = 64 * 1024;
const FORM_BODY_OVERHEAD_BYTES: u64 = 256;
const HEAP_SIZE: usize = 64 * 1024 * 1024;

struct Component;

impl Guest for Component {
    fn image(_config: Vec<u8>, request: ImageRequest) -> Result<ImageResponse, PluginError> {
        let action = protocol::OcrAction::parse(request.preferences.operation.as_deref())
            .map_err(map_protocol_error)?;
        let input = read_input_blob(&request.input)?;
        let image_base64 = BASE64.encode(input);
        let form = protocol::form_body(&image_base64).map_err(map_protocol_error)?;
        let max_body_bytes = protocol::encoded_image_max_bytes() as u64 + FORM_BODY_OVERHEAD_BYTES;
        let body = blob_create(
            BlobDirection::Output,
            Some(protocol::FORM_CONTENT_TYPE),
            max_body_bytes,
        )
        .map_err(map_resource_error)?;
        let written = blob_write(&body, 0, &form).map_err(map_resource_error)?;
        if written != form.len() as u64 {
            return Err(PluginError::Internal(String::from(
                "form blob write was incomplete",
            )));
        }
        let response = broker_fetch(BrokerRequest {
            endpoint_id: String::from(action.endpoint_id()),
            relative_path: String::from(action.relative_path()),
            method: String::from("POST"),
            headers: alloc::vec![(String::from("Accept"), String::from(ACCEPT_JSON))],
            body: BrokerBodyRequest::Blob(body),
        })
        .map_err(map_broker_error)?;
        let status = response.status;
        let body = json_body(response)?;
        let text = protocol::parse_response(status, &body).map_err(map_protocol_error)?;
        Ok(ImageResponse { text })
    }
}

fn read_input_blob(handle: &BlobHandle) -> Result<Vec<u8>, PluginError> {
    let length = blob_length(handle).map_err(map_resource_error)?;
    if length == 0 || length > protocol::OCR_IMAGE_MAX_DECODED_BYTES as u64 {
        return Err(PluginError::UnsupportedInput(String::from(
            "image exceeds size limit",
        )));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    let mut offset = 0u64;
    while offset < length {
        let chunk = blob_read(handle, offset, BLOB_READ_CHUNK_BYTES).map_err(map_resource_error)?;
        if chunk.is_empty() {
            return Err(PluginError::InvalidResponse(String::from(
                "input blob ended unexpectedly",
            )));
        }
        offset = offset.saturating_add(chunk.len() as u64);
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != length {
        return Err(PluginError::InvalidResponse(String::from(
            "input blob length changed",
        )));
    }
    Ok(bytes)
}

fn json_body(response: BrokerResponse) -> Result<Vec<u8>, PluginError> {
    match response.body {
        BrokerBodyResponse::Json(bytes) => Ok(bytes),
        _ => Err(PluginError::InvalidResponse(String::from(
            "expected JSON broker body",
        ))),
    }
}

fn map_resource_error(error: ResourceError) -> PluginError {
    match error {
        ResourceError::Cancelled => PluginError::Cancelled,
        ResourceError::OutOfBounds | ResourceError::Exhausted => {
            PluginError::UnsupportedInput(String::from("blob exceeds limit"))
        }
        ResourceError::NotOwned | ResourceError::WrongDirection | ResourceError::Closed => {
            PluginError::InvalidResponse(String::from("blob is unavailable"))
        }
        ResourceError::Internal(_) => PluginError::Internal(String::from("blob resource failed")),
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
            PluginError::InvalidRequest(String::from("invalid OCR action"))
        }
        protocol::ProtocolError::UnsupportedInput => {
            PluginError::UnsupportedInput(String::from("unsupported image"))
        }
        protocol::ProtocolError::Auth => PluginError::Auth,
        protocol::ProtocolError::RateLimited => PluginError::RateLimited,
        protocol::ProtocolError::QuotaExceeded => PluginError::QuotaExceeded,
        protocol::ProtocolError::ProviderUnavailable => PluginError::ProviderUnavailable,
        protocol::ProtocolError::InvalidResponse => {
            PluginError::InvalidResponse(String::from("invalid provider response"))
        }
    }
}

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicUsize, Ordering};

struct Bump {
    head: AtomicUsize,
    heap: UnsafeCell<[u8; HEAP_SIZE]>,
}

unsafe impl Sync for Bump {}

#[global_allocator]
static ALLOC: Bump = Bump {
    head: AtomicUsize::new(0),
    heap: UnsafeCell::new([0; HEAP_SIZE]),
};

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let size = layout.size();
        let align = layout.align();
        let heap_start = self.heap.get().cast::<u8>();
        loop {
            let current = self.head.load(Ordering::Relaxed);
            let aligned = (current + align - 1) & !(align - 1);
            let next = aligned + size;
            if next > HEAP_SIZE {
                core::arch::wasm32::unreachable();
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
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

export!(Component with_types_in self);
