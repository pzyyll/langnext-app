// ABOUTME: Generated Wasm Component Model bindings for the langnext runtime-plugin v1 WIT
// ABOUTME: package. All worlds import only `common` and `host`; no WASI interfaces are linked.
//! Bindings for the `langnext:runtime-plugin@1.0.0` WIT package.
//!
//! Each WIT world is generated in its own submodule because `bindgen!` targets a single world
//! per invocation. Host imports are async and trappable; exports are async. The three opaque
//! resources (`blob-handle`, `stream-writer`, `stream-reader`) are mapped to host-owned types in
//! [`super::host`]; guests never receive raw bytes, only table indices.
//!
//! Phase 2 wires Host trait implementations for the executed worlds (`translate-text-world`,
//! `translate-detect-world`) via [`impl_world_host!`]. The OCR/Speech/LLM/migration worlds are
//! generated so their bindings compile, but are not instantiated in Phase 2.
use super::host::{
  BROKER_UNSUPPORTED_BLOB_STREAM_MESSAGE, BlobResource, BrokerFetchError, BrokerFetchRequest, BrokerRequestBody,
  BrokerResponseBody, NeutralLogLevel, StreamReaderResource, StreamWriterResource,
};
use super::store::PluginHostState;
use wasmtime::component::bindgen;

/// Implements the generated `common::Host*` and `host::Host` traits for `PluginHostState` for one
/// generated world module. Blob/stream operations return a stable `unsupported` resource error
/// (Phase 6 implements them); broker/log/deadline/cancel delegate to neutral `PluginHostState`
/// helpers after converting generated WIT types to neutral host types.
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

      impl host::Host for PluginHostState {
        async fn broker_fetch(
          &mut self,
          request: BrokerRequest,
        ) -> wasmtime::Result<Result<BrokerResponse, BrokerError>> {
          let body = match request.body {
            BrokerBodyRequest::Empty => BrokerRequestBody::Empty,
            BrokerBodyRequest::Json(bytes) => BrokerRequestBody::Json(bytes),
            BrokerBodyRequest::Blob(handle) => {
              let _ = self.table.delete(handle);
              BrokerRequestBody::Blob
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
              // Blob/Stream response bodies are stable guest-visible unsupported results in
              // Phase 2 (never Wasmtime traps). Phase 6 implements real handles.
              let body = match response.body {
                BrokerResponseBody::Json(bytes) => BrokerBodyResponse::Json(bytes),
                BrokerResponseBody::Blob | BrokerResponseBody::Stream => {
                  return Ok(Err(BrokerError::Internal(
                    BROKER_UNSUPPORTED_BLOB_STREAM_MESSAGE.into(),
                  )));
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
          _direction: BlobDirection,
          _content_type: Option<String>,
          _max_bytes: u64,
        ) -> wasmtime::Result<Result<Resource<BlobResource>, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_write(
          &mut self,
          _handle: Resource<BlobResource>,
          _offset: u64,
          _bytes: Vec<u8>,
        ) -> wasmtime::Result<Result<u64, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_read(
          &mut self,
          _handle: Resource<BlobResource>,
          _offset: u64,
          _max_bytes: u64,
        ) -> wasmtime::Result<Result<Vec<u8>, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_length(
          &mut self,
          _handle: Resource<BlobResource>,
        ) -> wasmtime::Result<Result<u64, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_metadata(
          &mut self,
          _handle: Resource<BlobResource>,
        ) -> wasmtime::Result<Result<MediaMetadata, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_close(&mut self, handle: Resource<BlobResource>) -> wasmtime::Result<Result<(), ResourceError>> {
          let _ = self.table.delete(handle);
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn blob_discard(&mut self, handle: Resource<BlobResource>) -> wasmtime::Result<()> {
          let _ = self.table.delete(handle);
          Ok(())
        }

        async fn stream_create(
          &mut self,
          _kind: StreamKind,
          _content_type: Option<String>,
          _max_bytes: u64,
        ) -> wasmtime::Result<Result<(Resource<StreamWriterResource>, Resource<StreamReaderResource>), ResourceError>>
        {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_send(
          &mut self,
          _writer: Resource<StreamWriterResource>,
          _frame: StreamFrame,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_receive(
          &mut self,
          _reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<Option<StreamFrame>, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_state(
          &mut self,
          _reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<Option<StreamTerminalState>, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_finish(
          &mut self,
          writer: Resource<StreamWriterResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let _ = self.table.delete(writer);
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_fail(
          &mut self,
          writer: Resource<StreamWriterResource>,
          _code: String,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let _ = self.table.delete(writer);
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_cancel(
          &mut self,
          _reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_metadata(
          &mut self,
          _reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<MediaMetadata, ResourceError>> {
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_reader_close(
          &mut self,
          reader: Resource<StreamReaderResource>,
        ) -> wasmtime::Result<Result<(), ResourceError>> {
          let _ = self.table.delete(reader);
          Ok(Err(ResourceError::Internal("unsupported".into())))
        }
        async fn stream_reader_discard(&mut self, reader: Resource<StreamReaderResource>) -> wasmtime::Result<()> {
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

/// Bindings for `ocr-image-world`. Compiled but not instantiated in Phase 2.
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

/// Bindings for `speech-synthesize-world`. Compiled but not instantiated in Phase 2.
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
