// ABOUTME: Generated Wasm Component Model bindings for the langnext runtime-plugin v1 WIT
// ABOUTME: package. All worlds import only `common` and `host`; no WASI interfaces are linked.
//! Bindings for the `langnext:runtime-plugin@1.0.0` WIT package.
//!
//! Each WIT world is generated in its own submodule because `bindgen!` targets a single world
//! per invocation. Host imports are async and trappable; exports are async. The three opaque
//! resources (`blob-handle`, `stream-writer`, `stream-reader`) are mapped to host-owned types in
//! [`super::host`]; guests never receive raw bytes, only table indices.
//!
//! Host trait implementations for executed worlds via [`impl_world_host!`]. Phase 6 implements
//! blob/stream resource ops and broker JSON/bytes/stream response bodies.
use super::host::{
  BlobResource, BrokerFetchError, BrokerFetchRequest, BrokerRequestBody, BrokerResponseBody, NeutralLogLevel,
  StreamReaderResource, StreamWriterResource,
};
use super::store::PluginHostState;
use crate::domain::plugin_resource::{
  LlmCompletionStatus as DomainLlmCompletionStatus, LlmDelta as DomainLlmDelta,
  LlmToolCallDelta as DomainLlmToolCallDelta, ResourceCreateParams, ResourceDirection,
  ResourceError as DomainResourceError, ResourceOwner, StreamKind as DomainStreamKind,
  StreamTerminalState as DomainStreamTerminal,
};
use crate::services::stream_resources::StreamFrame as DomainStreamFrame;
use wasmtime::component::bindgen;

/// Implements the generated `common::Host*` and `host::Host` traits for `PluginHostState` for one
/// generated world module. Blob/stream ops and broker body unions are fully wired.
macro_rules! impl_world_host {
  ($world:ident) => {
    const _: () = {
      use host::*;
      use wasmtime::component::Resource;
      use $world::langnext::runtime_plugin::{common, host};

      fn map_broker_error(error: BrokerFetchError) -> BrokerError {
        match error {
          BrokerFetchError::NotApproved => BrokerError::NotApproved,
          BrokerFetchError::MethodNotAllowed => BrokerError::MethodNotAllowed,
          BrokerFetchError::PathConfined => BrokerError::PathConfined,
          BrokerFetchError::HeaderBlocked => BrokerError::HeaderBlocked,
          BrokerFetchError::Network(message) => BrokerError::Network(message),
          BrokerFetchError::Timeout => BrokerError::Timeout,
          BrokerFetchError::Cancelled => BrokerError::Cancelled,
          BrokerFetchError::LimitExceeded => BrokerError::LimitExceeded,
          BrokerFetchError::Internal(message) => BrokerError::Internal(message),
        }
      }

      fn map_resource_error(error: DomainResourceError) -> ResourceError {
        match error {
          DomainResourceError::NotOwned => ResourceError::NotOwned,
          DomainResourceError::WrongDirection => ResourceError::WrongDirection,
          DomainResourceError::Exhausted => ResourceError::Exhausted,
          DomainResourceError::OutOfBounds => ResourceError::OutOfBounds,
          DomainResourceError::Closed => ResourceError::Closed,
          DomainResourceError::Cancelled => ResourceError::Cancelled,
          DomainResourceError::Internal(message) => ResourceError::Internal(message),
        }
      }

      fn map_blob_direction(direction: BlobDirection) -> ResourceDirection {
        match direction {
          BlobDirection::Input => ResourceDirection::Input,
          BlobDirection::Output => ResourceDirection::Output,
        }
      }

      fn map_stream_kind(kind: StreamKind) -> DomainStreamKind {
        match kind {
          StreamKind::NetworkBinary => DomainStreamKind::NetworkBinary,
          StreamKind::LlmDelta => DomainStreamKind::LlmDelta,
        }
      }

      fn map_domain_terminal(term: DomainStreamTerminal) -> StreamTerminalState {
        match term {
          DomainStreamTerminal::Finished => StreamTerminalState::Finished,
          DomainStreamTerminal::Failed(code) => StreamTerminalState::Failed(code),
          DomainStreamTerminal::Cancelled => StreamTerminalState::Cancelled,
        }
      }

      fn map_domain_completion(status: DomainLlmCompletionStatus) -> common::LlmCompletionStatus {
        match status {
          DomainLlmCompletionStatus::Stop => common::LlmCompletionStatus::Stop,
          DomainLlmCompletionStatus::Length => common::LlmCompletionStatus::Length,
          DomainLlmCompletionStatus::ToolCalls => common::LlmCompletionStatus::ToolCalls,
        }
      }

      fn map_wit_completion(status: common::LlmCompletionStatus) -> DomainLlmCompletionStatus {
        match status {
          common::LlmCompletionStatus::Stop => DomainLlmCompletionStatus::Stop,
          common::LlmCompletionStatus::Length => DomainLlmCompletionStatus::Length,
          common::LlmCompletionStatus::ToolCalls => DomainLlmCompletionStatus::ToolCalls,
        }
      }

      fn map_domain_delta(delta: DomainLlmDelta) -> common::LlmDelta {
        match delta {
          DomainLlmDelta::Text(text) => common::LlmDelta::Text(text),
          DomainLlmDelta::Reasoning(text) => common::LlmDelta::Reasoning(text),
          DomainLlmDelta::ToolCall(tc) => common::LlmDelta::ToolCall(common::LlmToolCallDelta {
            id: tc.id,
            name: tc.name,
            arguments_json: tc.arguments_json,
          }),
          DomainLlmDelta::Complete(status) => common::LlmDelta::Complete(map_domain_completion(status)),
        }
      }

      fn map_wit_delta(delta: common::LlmDelta) -> Result<DomainLlmDelta, ResourceError> {
        let mapped = match delta {
          common::LlmDelta::Text(text) => DomainLlmDelta::Text(text),
          common::LlmDelta::Reasoning(text) => DomainLlmDelta::Reasoning(text),
          common::LlmDelta::ToolCall(tc) => DomainLlmDelta::ToolCall(DomainLlmToolCallDelta {
            id: tc.id,
            name: tc.name,
            arguments_json: tc.arguments_json,
          }),
          common::LlmDelta::Complete(status) => DomainLlmDelta::Complete(map_wit_completion(status)),
        };
        Ok(mapped)
      }

      fn map_domain_frame(frame: DomainStreamFrame) -> StreamFrame {
        match frame {
          DomainStreamFrame::NetworkBinary(bytes) => StreamFrame::NetworkBinary(bytes),
          DomainStreamFrame::LlmDelta(delta) => StreamFrame::LlmDelta(map_domain_delta(delta)),
          DomainStreamFrame::Terminal(term) => StreamFrame::Terminal(map_domain_terminal(term)),
        }
      }

      fn map_wit_frame(frame: StreamFrame) -> Result<DomainStreamFrame, ResourceError> {
        match frame {
          StreamFrame::NetworkBinary(bytes) => Ok(DomainStreamFrame::NetworkBinary(bytes)),
          StreamFrame::LlmDelta(delta) => {
            let domain_delta = map_wit_delta(delta)?;
            Ok(DomainStreamFrame::LlmDelta(domain_delta))
          }
          StreamFrame::Terminal(_) => Err(ResourceError::Internal("use finish/fail/cancel for terminal".into())),
        }
      }

      impl common::HostBlobHandle for PluginHostState {
        async fn drop(&mut self, rep: Resource<BlobResource>) -> wasmtime::Result<()> {
          if let Ok(resource) = self.table.delete(rep) {
            let principal = self.principal.clone();
            let _ = self.blobs.discard(resource.id, &principal);
          }
          Ok(())
        }
      }
      impl common::HostStreamWriter for PluginHostState {
        async fn drop(&mut self, rep: Resource<StreamWriterResource>) -> wasmtime::Result<()> {
          if let Ok(resource) = self.table.delete(rep) {
            self.streams.writer_drop(resource.id).await;
          }
          Ok(())
        }
      }
      impl common::HostStreamReader for PluginHostState {
        async fn drop(&mut self, rep: Resource<StreamReaderResource>) -> wasmtime::Result<()> {
          if let Ok(resource) = self.table.delete(rep) {
            let principal = self.principal.clone();
            self.streams.reader_discard(resource.id, &principal).await;
          }
          Ok(())
        }
      }
      impl common::Host for PluginHostState {}

      impl host::Host for PluginHostState {
        async fn broker_fetch(
          &mut self,
          request: BrokerRequest,
        ) -> wasmtime::Result<Result<BrokerResponse, BrokerError>> {
          let body = match request.body {
            BrokerBodyRequest::Empty => BrokerRequestBody::Empty,
            BrokerBodyRequest::Json(bytes) => BrokerRequestBody::Json(bytes),
            BrokerBodyRequest::Blob(handle) => {
              let resource = match self.table.get(&handle) {
                Ok(r) => r.id,
                Err(_) => return Ok(Err(BrokerError::Internal("invalid blob handle".into()))),
              };
              let principal = self.principal.clone();
              // Atomic consume: take bytes out of the BlobResourceTable and remove the entry in one
              // step so no inaccessible buffer remains. Validates owner + lifecycle; a repeat
              // consume fails because the entry (and the wasmtime handle below) is gone.
              let bytes = match self.blobs.take_bytes(resource, &principal) {
                Ok(b) => b,
                Err(_) => return Ok(Err(BrokerError::Internal("blob body unavailable".into()))),
              };
              let _ = self.table.delete(handle);
              let byte_len = bytes.len();
              BrokerRequestBody::Blob { bytes, byte_len }
            }
          };
          let neutral_request = BrokerFetchRequest {
            endpoint_id: request.endpoint_id,
            relative_path: request.relative_path,
            method: request.method,
            headers: request.headers,
            body,
          };
          let outcome = self.do_broker_fetch(neutral_request).await;
          match outcome {
            Ok(response) => {
              let body = match response.body {
                BrokerResponseBody::Json(bytes) => BrokerBodyResponse::Json(bytes),
                BrokerResponseBody::Bytes { content_type, bytes } => {
                  let principal = self.principal.clone();
                  let params = ResourceCreateParams {
                    owner: ResourceOwner::from_principal(&principal),
                    direction: ResourceDirection::Input,
                    content_type,
                    max_bytes: bytes.len().max(1) as u64,
                    expires_at: None,
                    cancel: self.cancel.clone(),
                  };
                  let id = match self.blobs.create_with_bytes(params, bytes) {
                    Ok(id) => id,
                    Err(e) => {
                      return Ok(Err(BrokerError::Internal(format!("blob wrap failed: {e}"))));
                    }
                  };
                  let handle = match self.table.push(BlobResource { id }) {
                    Ok(h) => h,
                    Err(e) => return Ok(Err(BrokerError::Internal(e.to_string()))),
                  };
                  BrokerBodyResponse::Blob(handle)
                }
                BrokerResponseBody::Stream { reader } => {
                  let reader_id = match self.streams.adopt_reader(reader) {
                    Ok(id) => id,
                    Err(e) => {
                      return Ok(Err(BrokerError::Internal(format!("stream adopt failed: {e}"))));
                    }
                  };
                  let handle = match self.table.push(StreamReaderResource { id: reader_id }) {
                    Ok(h) => h,
                    Err(e) => return Ok(Err(BrokerError::Internal(e.to_string()))),
                  };
                  BrokerBodyResponse::Stream(handle)
                }
              };
              Ok(Ok(BrokerResponse {
                status: response.status,
                headers: response.headers,
                body,
              }))
            }
            Err(error) => Ok(Err(map_broker_error(error))),
          }
        }

        async fn log(
          &mut self,
          level: LogLevel,
          message: String,
          fields: Vec<(String, String)>,
        ) -> wasmtime::Result<()> {
          let neutral_level = match level {
            LogLevel::Trace => NeutralLogLevel::Trace,
            LogLevel::Debug => NeutralLogLevel::Debug,
            LogLevel::Info => NeutralLogLevel::Info,
            LogLevel::Warn => NeutralLogLevel::Warn,
            LogLevel::Error => NeutralLogLevel::Error,
          };
          self.do_log(neutral_level, &message, &fields);
          Ok(())
        }

        async fn deadline_remaining(&mut self) -> wasmtime::Result<Option<u64>> {
          Ok(self.do_deadline_remaining())
        }

        async fn is_cancelled(&mut self) -> wasmtime::Result<bool> {
          Ok(self.do_is_cancelled())
        }

        async fn blob_create(
          &mut self,
          direction: BlobDirection,
          content_type: Option<String>,
          max_bytes: u64,
        ) -> wasmtime::Result<Result<Resource<BlobResource>, ResourceError>> {
          let principal = self.principal.clone();
          let params = ResourceCreateParams {
            owner: ResourceOwner::from_principal(&principal),
            direction: map_blob_direction(direction),
            content_type,
            max_bytes,
            expires_at: None,
            cancel: self.cancel.clone(),
          };
          match self.blobs.create(params) {
            Ok(id) => match self.table.push(BlobResource { id }) {
              Ok(handle) => Ok(Ok(handle)),
              Err(e) => Ok(Err(ResourceError::Internal(e.to_string()))),
            },
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn blob_write(
          &mut self,
          handle: Resource<BlobResource>,
          offset: u64,
          bytes: Vec<u8>,
        ) -> wasmtime::Result<Result<u64, ResourceError>> {
          let id = match self.table.get(&handle) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          Ok(
            self
              .blobs
              .write(id, &principal, offset, &bytes)
              .map_err(map_resource_error),
          )
        }
        async fn blob_read(
          &mut self,
          handle: Resource<BlobResource>,
          offset: u64,
          max_bytes: u64,
        ) -> wasmtime::Result<Result<Vec<u8>, ResourceError>> {
          let id = match self.table.get(&handle) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          Ok(
            self
              .blobs
              .read(id, &principal, offset, max_bytes)
              .map_err(map_resource_error),
          )
        }
        async fn blob_length(
          &mut self,
          handle: Resource<BlobResource>,
        ) -> wasmtime::Result<Result<u64, ResourceError>> {
          let id = match self.table.get(&handle) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          Ok(self.blobs.length(id, &principal).map_err(map_resource_error))
        }
        async fn blob_metadata(
          &mut self,
          handle: Resource<BlobResource>,
        ) -> wasmtime::Result<Result<MediaMetadata, ResourceError>> {
          let id = match self.table.get(&handle) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          match self.blobs.metadata(id, &principal) {
            Ok(meta) => Ok(Ok(MediaMetadata {
              content_type: meta.content_type,
              byte_length: meta.byte_length,
            })),
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn blob_close(&mut self, handle: Resource<BlobResource>) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&handle) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          let result = self.blobs.close(id, &principal).map_err(map_resource_error);
          let _ = self.table.delete(handle);
          Ok(result)
        }
        async fn blob_discard(&mut self, handle: Resource<BlobResource>) -> wasmtime::Result<()> {
          if let Ok(resource) = self.table.get(&handle).map(|r| r.id) {
            let principal = self.principal.clone();
            let _ = self.blobs.discard(resource, &principal);
          }
          let _ = self.table.delete(handle);
          Ok(())
        }

        async fn stream_create(
          &mut self,
          kind: StreamKind,
          content_type: Option<String>,
          max_bytes: u64,
        ) -> wasmtime::Result<Result<(Resource<StreamWriterResource>, Resource<StreamReaderResource>), ResourceError>>
        {
          let principal = self.principal.clone();
          let params = ResourceCreateParams {
            owner: ResourceOwner::from_principal(&principal),
            direction: ResourceDirection::Output,
            content_type,
            max_bytes,
            expires_at: None,
            cancel: self.cancel.clone(),
          };
          match self.streams.create(params, map_stream_kind(kind), None) {
            Ok((writer_id, reader_id)) => {
              let writer = match self.table.push(StreamWriterResource { id: writer_id }) {
                Ok(h) => h,
                Err(e) => return Ok(Err(ResourceError::Internal(e.to_string()))),
              };
              let reader = match self.table.push(StreamReaderResource { id: reader_id }) {
                Ok(h) => h,
                Err(e) => return Ok(Err(ResourceError::Internal(e.to_string()))),
              };
              Ok(Ok((writer, reader)))
            }
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn stream_send(
          &mut self,
          writer: Resource<StreamWriterResource>,
          frame: StreamFrame,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&writer) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let domain_frame = match map_wit_frame(frame) {
            Ok(f) => f,
            Err(e) => return Ok(Err(e)),
          };
          let principal = self.principal.clone();
          let deadline = self.deadline;
          let cancel = self.cancel.clone();
          Ok(
            self
              .streams
              .send(id, &principal, domain_frame, deadline, Some(&cancel))
              .await
              .map_err(map_resource_error),
          )
        }
        async fn stream_receive(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<Option<StreamFrame>, ResourceError>> {
          let id = match self.table.get(&reader) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          let deadline = self.deadline;
          let cancel = self.cancel.clone();
          match self.streams.receive(id, &principal, deadline, Some(&cancel)).await {
            Ok(Some(frame)) => Ok(Ok(Some(map_domain_frame(frame)))),
            Ok(None) => Ok(Ok(None)),
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn stream_state(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<Option<StreamTerminalState>, ResourceError>> {
          let id = match self.table.get(&reader) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          match self.streams.state(id, &principal).await {
            Ok(Some(term)) => Ok(Ok(Some(map_domain_terminal(term)))),
            Ok(None) => Ok(Ok(None)),
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn stream_finish(
          &mut self,
          writer: Resource<StreamWriterResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&writer) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          let result = self.streams.finish(id, &principal).await.map_err(map_resource_error);
          let _ = self.table.delete(writer);
          Ok(result)
        }
        async fn stream_fail(
          &mut self,
          writer: Resource<StreamWriterResource>,
          code: String,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&writer) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          let result = self
            .streams
            .fail(id, &principal, &code)
            .await
            .map_err(map_resource_error);
          let _ = self.table.delete(writer);
          Ok(result)
        }
        async fn stream_cancel(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&reader) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          Ok(self.streams.cancel(id, &principal).await.map_err(map_resource_error))
        }
        async fn stream_metadata(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<MediaMetadata, ResourceError>> {
          let id = match self.table.get(&reader) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          match self.streams.metadata(id, &principal).await {
            Ok(meta) => Ok(Ok(MediaMetadata {
              content_type: meta.content_type,
              byte_length: meta.byte_length,
            })),
            Err(e) => Ok(Err(map_resource_error(e))),
          }
        }
        async fn stream_reader_close(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let id = match self.table.get(&reader) {
            Ok(r) => r.id,
            Err(_) => return Ok(Err(ResourceError::NotOwned)),
          };
          let principal = self.principal.clone();
          let result = self
            .streams
            .reader_close(id, &principal)
            .await
            .map_err(map_resource_error);
          let _ = self.table.delete(reader);
          Ok(result)
        }
        async fn stream_reader_discard(&mut self, reader: Resource<StreamReaderResource>) -> wasmtime::Result<()> {
          if let Ok(resource) = self.table.get(&reader).map(|r| r.id) {
            let principal = self.principal.clone();
            self.streams.reader_discard(resource, &principal).await;
          }
          let _ = self.table.delete(reader);
          Ok(())
        }
      }
    };
  };
}

/// Bindings for `translate-text-world` (exports `translate.text@1`). Executed in Phase 2.
pub mod translate_text {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "translate-text-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(translate_text);

/// Bindings for `translate-detect-world` (exports `translate.detect@1`). Executed in Phase 2.
pub mod translate_detect {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "translate-detect-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(translate_detect);

/// Bindings for `ocr-image-world` (`ocr.image@1`).
pub mod ocr_image {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "ocr-image-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(ocr_image);

/// Bindings for `speech-synthesize-world` (exports `speech.synthesize@1`). Executed in Phase 6.
pub mod speech_synthesize {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "speech-synthesize-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(speech_synthesize);

/// Bindings for `speech-recognize-world`. Compiled but not instantiated in Phase 2.
pub mod speech_recognize {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "speech-recognize-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}

/// Bindings for `llm-models-world`. Compiled but not instantiated in Phase 2.
pub mod llm_models {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "llm-models-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(llm_models);

/// Bindings for `llm-chat-world`. Compiled but not instantiated in Phase 2.
pub mod llm_chat {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "llm-chat-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}
impl_world_host!(llm_chat);

/// Bindings for `migration-world` (pure copied-JSON exports). Instantiated for lifecycle upgrades.
pub mod migration {
  use super::bindgen;
  bindgen!({
    path: "wit/runtime-plugin",
    world: "migration-world",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
      "langnext:runtime-plugin/common.blob-handle": super::super::host::BlobResource,
      "langnext:runtime-plugin/common.stream-writer": super::super::host::StreamWriterResource,
      "langnext:runtime-plugin/common.stream-reader": super::super::host::StreamReaderResource,
    },
  });
}

// Migration world imports only `common` (no host). Implement common Host* for PluginHostState.
const _: () = {
  use super::host::{BlobResource, StreamReaderResource, StreamWriterResource};
  use super::store::PluginHostState;
  use migration::langnext::runtime_plugin::common;
  use wasmtime::component::Resource;

  impl common::HostBlobHandle for PluginHostState {
    async fn drop(&mut self, rep: Resource<BlobResource>) -> wasmtime::Result<()> {
      let _ = self.table.delete(rep);
      Ok(())
    }
  }
  impl common::HostStreamWriter for PluginHostState {
    async fn drop(&mut self, rep: Resource<StreamWriterResource>) -> wasmtime::Result<()> {
      let _ = self.table.delete(rep);
      Ok(())
    }
  }
  impl common::HostStreamReader for PluginHostState {
    async fn drop(&mut self, rep: Resource<StreamReaderResource>) -> wasmtime::Result<()> {
      let _ = self.table.delete(rep);
      Ok(())
    }
  }
  impl common::Host for PluginHostState {}
};
