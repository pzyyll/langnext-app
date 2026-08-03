// ABOUTME: Host-owned ordered stream lifecycle with single-producer/single-consumer backpressure.
// ABOUTME: Terminal finished|failed|cancelled; consumer disconnect cancels the producer side.
use crate::domain::cancel::CancelToken;
use crate::domain::plugin_resource::{
  LlmDelta, MediaMetadata, RESOURCE_MAX_CHUNK_BYTES, ResourceCreateParams, ResourceError, ResourceId, ResourceOwner,
  STREAM_ABSOLUTE_BUFFER_FRAMES, STREAM_DEFAULT_BUFFER_FRAMES, StreamKind, StreamTerminalState,
};
use crate::domain::runtime_plugin::PluginPrincipal;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

/// Maximum wait while the producer is blocked on a full buffer.
pub const STREAM_BACKPRESSURE_WAIT: Duration = Duration::from_secs(30);

/// Typed stream frame payloads (matches WIT `stream-frame` non-terminal arms + terminal).
/// LLM deltas carry typed domain structures losslessly; the host never encodes arbitrary JSON
/// then guesses on receive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamFrame {
  NetworkBinary(Vec<u8>),
  /// Structured LLM delta preserved as its exact WIT variant.
  LlmDelta(LlmDelta),
  Terminal(StreamTerminalState),
}

impl StreamFrame {
  fn kind_matches(&self, kind: StreamKind) -> bool {
    match (self, kind) {
      (Self::NetworkBinary(_), StreamKind::NetworkBinary) => true,
      (Self::LlmDelta(_), StreamKind::LlmDelta) => true,
      (Self::Terminal(_), _) => true,
      _ => false,
    }
  }

  fn byte_len(&self) -> u64 {
    match self {
      Self::NetworkBinary(b) => b.len() as u64,
      // Typed deltas are not byte-counted against the stream byte cap; only network-binary
      // chunks and the frame count/backpressure bound them. This mirrors the WIT contract where
      // llm-delta is a structured value, not opaque bytes.
      Self::LlmDelta(_) => 0,
      Self::Terminal(_) => 0,
    }
  }
}

/// Mutable stream payload protected by a mutex; notifies live outside the lock.
struct StreamData {
  owner: ResourceOwner,
  kind: StreamKind,
  content_type: Option<String>,
  max_bytes: u64,
  buffer_frames: usize,
  bytes_sent: u64,
  buffer: VecDeque<StreamFrame>,
  terminal: Option<StreamTerminalState>,
  writer_open: bool,
  reader_open: bool,
  expires_at: Instant,
  cancel_check: Box<dyn Fn() -> bool + Send + Sync>,
  /// Transport-specific cancel token for broker-backed network-binary streams. When present,
  /// any terminal transition (cancel/close/expiry/fail) fires it so the upstream transport
  /// task stops promptly instead of continuing to pump into a closed reader.
  transport_cancel: Option<CancelToken>,
}

impl StreamData {
  /// Set the terminal state exactly once (idempotent) and fire the transport cancel token so a
  /// broker pump's upstream transport task stops promptly. Centralizes terminal transitions so
  /// every path cancels the transport without each caller repeating the trigger.
  fn set_terminal(&mut self, terminal: StreamTerminalState) {
    if self.terminal.is_none() {
      self.terminal = Some(terminal);
    }
    self.writer_open = false;
    if let Some(token) = &self.transport_cancel {
      token.cancel();
    }
  }
}

/// Shared stream state behind writer/reader endpoints.
struct StreamShared {
  data: Mutex<StreamData>,
  space_notify: Notify,
  data_notify: Notify,
}

/// Host stream table: pairs of writer/reader ids sharing one `StreamShared`.
#[derive(Default)]
pub struct StreamResourceTable {
  writers: HashMap<ResourceId, Arc<StreamShared>>,
  readers: HashMap<ResourceId, Arc<StreamShared>>,
  request_index: HashMap<String, Vec<(ResourceId, ResourceId)>>,
  /// Broker pump supervisors for adopted network-binary readers. Keyed by reader id so
  /// [`Self::reader_close`] / [`Self::remove_for_request`] / [`Self::clear`] can cancel the
  /// upstream transport task and join its cleanup rather than detaching it.
  supervisors: HashMap<ResourceId, Arc<StreamPumpSupervisor>>,
}

impl StreamResourceTable {
  pub fn new() -> Self {
    Self::default()
  }

  /// Create a single-producer/single-consumer stream pair bound to one owner/kind/cap.
  pub fn create(
    &mut self,
    params: ResourceCreateParams,
    kind: StreamKind,
    buffer_frames: Option<usize>,
  ) -> Result<(ResourceId, ResourceId), ResourceError> {
    params.validate()?;
    let buffer_frames = buffer_frames
      .unwrap_or(STREAM_DEFAULT_BUFFER_FRAMES)
      .clamp(1, STREAM_ABSOLUTE_BUFFER_FRAMES);
    let writer_id = ResourceId::generate();
    let reader_id = ResourceId::generate();
    let expires_at = params.effective_expiry();
    let cancel = params.cancel.clone();
    let request_id = params.owner.request_id().to_string();
    let shared = Arc::new(StreamShared {
      data: Mutex::new(StreamData {
        owner: params.owner,
        kind,
        content_type: params.content_type,
        max_bytes: params.max_bytes,
        buffer_frames,
        bytes_sent: 0,
        buffer: VecDeque::with_capacity(buffer_frames),
        terminal: None,
        writer_open: true,
        reader_open: true,
        expires_at,
        cancel_check: Box::new(move || cancel.is_cancelled()),
        transport_cancel: None,
      }),
      space_notify: Notify::new(),
      data_notify: Notify::new(),
    });
    self.writers.insert(writer_id, shared.clone());
    self.readers.insert(reader_id, shared);
    self
      .request_index
      .entry(request_id)
      .or_default()
      .push((writer_id, reader_id));
    Ok((writer_id, reader_id))
  }

  /// Send one ordered frame. Blocks (async) under backpressure until space, deadline, or cancel.
  /// The request `CancelToken` is awaited directly so cancellation is prompt even while the
  /// producer is blocked under backpressure.
  pub async fn send(
    &self,
    writer_id: ResourceId,
    principal: &PluginPrincipal,
    frame: StreamFrame,
    deadline: Option<Instant>,
    cancel: Option<&CancelToken>,
  ) -> Result<(), ResourceError> {
    let shared = self.writers.get(&writer_id).ok_or(ResourceError::NotOwned)?.clone();
    StreamWriterHandle { shared }
      .send(principal, frame, deadline, cancel)
      .await
  }

  /// Detach a table-owned reader into a host-side [`LlmReaderBridge`] so the host can consume
  /// the reader concurrently while a guest owns the paired writer (llm-delta chat streaming).
  /// The bridge keeps the shared pair state alive; the writer entry stays in this table until
  /// the guest finishes/drops it and request cleanup runs.
  pub fn detach_reader(&mut self, reader_id: ResourceId) -> Result<LlmReaderBridge, ResourceError> {
    let shared = self.readers.remove(&reader_id).ok_or(ResourceError::NotOwned)?;
    let request_id = {
      let data = shared
        .data
        .try_lock()
        .map_err(|_| ResourceError::Internal("stream locked".into()))?;
      data.owner.request_id().to_string()
    };
    Ok(LlmReaderBridge { shared, request_id })
  }

  /// Receive the next frame, or `None` after a terminal state has been observed.
  /// The request `CancelToken` is awaited directly so a blocked consumer wakes promptly on cancel.
  pub async fn receive(
    &self,
    reader_id: ResourceId,
    principal: &PluginPrincipal,
    deadline: Option<Instant>,
    cancel: Option<&CancelToken>,
  ) -> Result<Option<StreamFrame>, ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    receive_shared(&shared, principal, deadline, cancel).await
  }

  /// Non-blocking receive for host pumps that already hold frames (returns None if empty & open).
  pub async fn try_receive(
    &self,
    reader_id: ResourceId,
    principal: &PluginPrincipal,
  ) -> Result<Option<StreamFrame>, ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    let mut data = shared.data.lock().await;
    Self::refresh(&mut data);
    Self::check_owner(&data, principal)?;
    if !data.reader_open {
      return Err(ResourceError::Closed);
    }
    if let Some(frame) = data.buffer.pop_front() {
      drop(data);
      shared.space_notify.notify_waiters();
      return Ok(Some(frame));
    }
    if let Some(term) = data.terminal.clone() {
      return Ok(Some(StreamFrame::Terminal(term)));
    }
    Ok(None)
  }

  pub async fn state(
    &self,
    reader_id: ResourceId,
    principal: &PluginPrincipal,
  ) -> Result<Option<StreamTerminalState>, ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    let mut data = shared.data.lock().await;
    Self::refresh(&mut data);
    Self::check_owner(&data, principal)?;
    Ok(data.terminal.clone())
  }

  pub async fn metadata(
    &self,
    reader_id: ResourceId,
    principal: &PluginPrincipal,
  ) -> Result<MediaMetadata, ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    let mut data = shared.data.lock().await;
    Self::refresh(&mut data);
    Self::check_owner(&data, principal)?;
    Ok(MediaMetadata {
      content_type: data.content_type.clone(),
      byte_length: Some(data.bytes_sent),
    })
  }

  /// Seal the writer with `finished`. Exactly one terminal transition is allowed.
  pub async fn finish(&mut self, writer_id: ResourceId, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    self
      .terminate_writer(writer_id, principal, StreamTerminalState::Finished)
      .await
  }

  pub async fn fail(
    &mut self,
    writer_id: ResourceId,
    principal: &PluginPrincipal,
    code: &str,
  ) -> Result<(), ResourceError> {
    self
      .terminate_writer(writer_id, principal, StreamTerminalState::failed_sanitized(code))
      .await
  }

  /// Reader-side cancellation propagates to the producer.
  pub async fn cancel(&self, reader_id: ResourceId, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    {
      let mut data = shared.data.lock().await;
      Self::refresh(&mut data);
      Self::check_owner(&data, principal)?;
      if data.terminal.is_some() {
        return Ok(());
      }
      data.set_terminal(StreamTerminalState::Cancelled);
    }
    shared.space_notify.notify_waiters();
    shared.data_notify.notify_waiters();
    Ok(())
  }

  pub async fn reader_close(
    &mut self,
    reader_id: ResourceId,
    principal: &PluginPrincipal,
  ) -> Result<(), ResourceError> {
    let shared = self.readers.get(&reader_id).ok_or(ResourceError::NotOwned)?.clone();
    {
      let mut data = shared.data.lock().await;
      Self::check_owner(&data, principal)?;
      data.reader_open = false;
      if data.terminal.is_none() {
        data.set_terminal(StreamTerminalState::Cancelled);
      }
      data.buffer.clear();
    }
    shared.space_notify.notify_waiters();
    shared.data_notify.notify_waiters();
    self.readers.remove(&reader_id);
    // Join/supervise broker pump cleanup: the transport cancel token already fired via
    // `set_terminal`; `shutdown` awaits the pump/transport tasks so reader close does not leave
    // detached tasks running against a closed consumer.
    if let Some(supervisor) = self.supervisors.remove(&reader_id) {
      supervisor.shutdown().await;
    }
    Ok(())
  }

  pub async fn reader_discard(&mut self, reader_id: ResourceId, principal: &PluginPrincipal) {
    let _ = self.reader_close(reader_id, principal).await;
  }

  /// Drop writer endpoint after terminal (or force-cancel if still open).
  pub async fn writer_drop(&mut self, writer_id: ResourceId) {
    if let Some(shared) = self.writers.remove(&writer_id) {
      {
        let mut data = shared.data.lock().await;
        if data.terminal.is_none() {
          data.set_terminal(StreamTerminalState::Cancelled);
        } else {
          data.writer_open = false;
        }
      }
      shared.data_notify.notify_waiters();
      shared.space_notify.notify_waiters();
    }
  }

  pub fn remove_for_request(&mut self, request_id: &str) {
    if let Some(pairs) = self.request_index.remove(request_id) {
      for (w, r) in pairs {
        self.writers.remove(&w);
        self.readers.remove(&r);
        // Sync request cleanup cannot await joins, so explicitly abort both tasks after
        // signalling cancellation. Dropping a JoinHandle would detach it instead.
        if let Some(supervisor) = self.supervisors.remove(&r) {
          supervisor.abort();
        }
      }
    }
  }

  pub fn clear(&mut self) {
    // Store drop is synchronous. Cancel and explicitly abort every owned task before releasing
    // the supervisors; dropping JoinHandles alone would detach them from host supervision.
    for supervisor in self.supervisors.values() {
      supervisor.abort();
    }
    self.writers.clear();
    self.readers.clear();
    self.request_index.clear();
    self.supervisors.clear();
  }

  pub fn writer_count(&self) -> usize {
    self.writers.len()
  }

  pub fn reader_count(&self) -> usize {
    self.readers.len()
  }

  /// Create a network-binary stream pair for a host-driven broker pump, returning independent
  /// producer/consumer handles plus the transport cancel token. The pair is NOT inserted into
  /// this table; the caller drives the [`StreamWriterHandle`] from a pump task and adopts the
  /// [`StreamReaderHandle`] into the request's stream table via [`Self::adopt_reader`]. The
  /// returned [`StreamReaderHandle`] carries a [`StreamPumpSupervisor`] whose cancel token is
  /// stored in the shared stream state, so any terminal transition (reader close/cancel/expiry)
  /// cancels the upstream transport task. This decouples the producer lifecycle from any table
  /// so a broker pump can run concurrently with host-side reads without detaching uncancelled work.
  pub fn create_network_binary_pair(
    params: ResourceCreateParams,
  ) -> Result<(StreamWriterHandle, StreamReaderHandle), ResourceError> {
    params.validate()?;
    let buffer_frames = STREAM_DEFAULT_BUFFER_FRAMES.clamp(1, STREAM_ABSOLUTE_BUFFER_FRAMES);
    let expires_at = params.effective_expiry();
    let cancel = params.cancel.clone();
    let request_id = params.owner.request_id().to_string();
    // Transport-specific cancel token: stored in the shared state so terminal transitions fire it,
    // and held by the supervisor so the host can join the pump/transport tasks on reader close.
    let transport_cancel = CancelToken::new();
    let supervisor = Arc::new(StreamPumpSupervisor::new(transport_cancel.clone()));
    let shared = Arc::new(StreamShared {
      data: Mutex::new(StreamData {
        owner: params.owner,
        kind: StreamKind::NetworkBinary,
        content_type: params.content_type,
        max_bytes: params.max_bytes,
        buffer_frames,
        bytes_sent: 0,
        buffer: VecDeque::with_capacity(buffer_frames),
        terminal: None,
        writer_open: true,
        reader_open: true,
        expires_at,
        cancel_check: Box::new(move || cancel.is_cancelled()),
        transport_cancel: Some(transport_cancel),
      }),
      space_notify: Notify::new(),
      data_notify: Notify::new(),
    });
    Ok((
      StreamWriterHandle { shared: shared.clone() },
      StreamReaderHandle {
        shared,
        request_id,
        supervisor: Some(supervisor),
      },
    ))
  }

  /// Adopt an externally-created reader (e.g. from a broker pump) into this table, returning a
  /// fresh reader id the host can hand to the guest. The reader's immutable owner/request id is
  /// carried on the handle itself, so adoption needs no lock (no `blocking_lock` from async).
  /// The carried [`StreamPumpSupervisor`] (if any) is stored so [`Self::reader_close`] can join
  /// the broker pump cleanup; the request_index is populated for request-scoped cleanup.
  pub fn adopt_reader(&mut self, handle: StreamReaderHandle) -> Result<ResourceId, ResourceError> {
    let reader_id = ResourceId::generate();
    let request_id = handle.request_id.clone();
    if let Some(supervisor) = handle.supervisor.clone() {
      self.supervisors.insert(reader_id, supervisor);
    }
    self.readers.insert(reader_id, handle.shared);
    self
      .request_index
      .entry(request_id)
      .or_default()
      .push((reader_id, reader_id));
    Ok(reader_id)
  }

  async fn terminate_writer(
    &mut self,
    writer_id: ResourceId,
    principal: &PluginPrincipal,
    terminal: StreamTerminalState,
  ) -> Result<(), ResourceError> {
    let shared = self.writers.get(&writer_id).ok_or(ResourceError::NotOwned)?.clone();
    {
      let mut data = shared.data.lock().await;
      Self::refresh(&mut data);
      Self::check_owner(&data, principal)?;
      if !data.writer_open {
        return Err(ResourceError::Closed);
      }
      if data.terminal.is_some() {
        return Err(ResourceError::Closed);
      }
      data.set_terminal(terminal);
    }
    shared.data_notify.notify_waiters();
    shared.space_notify.notify_waiters();
    self.writers.remove(&writer_id);
    Ok(())
  }

  fn check_owner(data: &StreamData, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    if data.owner.matches_principal(principal) {
      Ok(())
    } else {
      Err(ResourceError::NotOwned)
    }
  }

  fn refresh(data: &mut StreamData) {
    if data.terminal.is_some() {
      return;
    }
    if (data.cancel_check)() {
      data.set_terminal(StreamTerminalState::Cancelled);
      return;
    }
    if Instant::now() >= data.expires_at {
      data.set_terminal(StreamTerminalState::Failed("expired".into()));
    }
  }
}

/// Receive the next frame from a reader's shared state, or `None` after a terminal state has
/// been observed. Shared by [`StreamResourceTable::receive`] and [`LlmReaderBridge::receive`]
/// so a detached reader (guest-owned writer) keeps the same ordering/backpressure/terminal
/// semantics as a table-owned reader.
async fn receive_shared(
  shared: &Arc<StreamShared>,
  principal: &PluginPrincipal,
  deadline: Option<Instant>,
  cancel: Option<&CancelToken>,
) -> Result<Option<StreamFrame>, ResourceError> {
  loop {
    let notified = shared.data_notify.notified();
    {
      let mut data = shared.data.lock().await;
      StreamResourceTable::refresh(&mut data);
      StreamResourceTable::check_owner(&data, principal)?;
      if !data.reader_open {
        return Err(ResourceError::Closed);
      }
      if let Some(frame) = data.buffer.pop_front() {
        drop(data);
        shared.space_notify.notify_waiters();
        return Ok(Some(frame));
      }
      if let Some(term) = data.terminal.clone() {
        data.reader_open = false;
        return Ok(Some(StreamFrame::Terminal(term)));
      }
      if !data.writer_open {
        data.terminal = Some(StreamTerminalState::Cancelled);
        return Ok(Some(StreamFrame::Terminal(StreamTerminalState::Cancelled)));
      }
    }
    tokio::select! {
      biased;
      _ = notified => continue,
      _ = cancel_cancelled(cancel) => return Err(ResourceError::Cancelled),
      _ = tokio::time::sleep(STREAM_BACKPRESSURE_WAIT) => {
        return Err(ResourceError::Internal("receive deadline".into()));
      }
      _ = sleep_until_deadline(deadline) => {
        return Err(ResourceError::Internal("request deadline".into()));
      }
    }
  }
}

/// Host-side reader bridge for an llm-delta stream pair whose writer is owned by a guest
/// (streaming chat). The guest call borrows the request store, so the reader's shared state is
/// detached into this bridge before the call; the bridge is dropped (releasing the pair state)
/// after the host has drained the reader and the guest call has completed.
#[derive(Clone)]
pub struct LlmReaderBridge {
  shared: Arc<StreamShared>,
  request_id: String,
}

impl LlmReaderBridge {
  /// The immutable request id bound to this pair (owner scope for cleanup bookkeeping).
  pub fn request_id(&self) -> &str {
    &self.request_id
  }

  /// Receive the next ordered frame with the same semantics as [`StreamResourceTable::receive`].
  pub async fn receive(
    &self,
    principal: &PluginPrincipal,
    deadline: Option<Instant>,
    cancel: Option<&CancelToken>,
  ) -> Result<Option<StreamFrame>, ResourceError> {
    receive_shared(&self.shared, principal, deadline, cancel).await
  }

  /// Force-cancel a still-open pair and notify waiters (idempotent cleanup when the host stops
  /// draining before a terminal state; a still-open guest writer observes `Cancelled`).
  pub async fn discard(&self) {
    {
      let mut data = self.shared.data.lock().await;
      if data.terminal.is_none() {
        data.set_terminal(StreamTerminalState::Cancelled);
      } else {
        data.writer_open = false;
      }
    }
    self.shared.data_notify.notify_waiters();
    self.shared.space_notify.notify_waiters();
  }
}

/// Await cancellation when a `CancelToken` is supplied; pending forever otherwise. Used in the
/// backpressure `select!` so a blocked producer/consumer wakes promptly on cancel.
async fn cancel_cancelled(cancel: Option<&CancelToken>) {
  match cancel {
    Some(token) => token.cancelled().await,
    None => std::future::pending::<()>().await,
  }
}

/// Opaque handle to a stream reader's shared state, for adopting a broker-created reader into the
/// host request's stream table without exposing internal `StreamShared` fields. Carries the
/// immutable request id and an optional broker pump supervisor so adoption needs no lock and
/// reader close can join the pump/transport cleanup.
#[derive(Clone)]
pub struct StreamReaderHandle {
  shared: Arc<StreamShared>,
  request_id: String,
  supervisor: Option<Arc<StreamPumpSupervisor>>,
}

impl StreamReaderHandle {
  /// The transport cancel token for the broker pump backing this reader, if any. The pump passes
  /// this to `transport.stream` so terminal transitions (reader close/cancel/expiry) stop the
  /// upstream transport promptly.
  pub fn transport_cancel(&self) -> Option<CancelToken> {
    self.supervisor.as_ref().map(|s| s.transport_cancel())
  }

  /// Install the spawned pump/transport task handles so the supervisor can join them on shutdown.
  /// Called by the broker pump after spawning both tasks and before returning the reader.
  pub fn install_pump_handles(&mut self, transport: tokio::task::JoinHandle<()>, pump: tokio::task::JoinHandle<()>) {
    if let Some(supervisor) = &self.supervisor {
      supervisor.install_handles(transport, pump);
    }
  }
}

impl std::fmt::Debug for StreamReaderHandle {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("StreamReaderHandle").finish_non_exhaustive()
  }
}

/// Producer endpoint for a host-driven network stream pump. Owns the writer side of a
/// single-producer/single-consumer pair independently of any [`StreamResourceTable`], so a
/// broker pump task can drive chunks while the host adopts the paired reader.
pub struct StreamWriterHandle {
  shared: Arc<StreamShared>,
}

impl StreamWriterHandle {
  /// Send one ordered frame. Blocks under backpressure until space, deadline, or cancel.
  pub async fn send(
    &self,
    principal: &PluginPrincipal,
    frame: StreamFrame,
    deadline: Option<Instant>,
    cancel: Option<&CancelToken>,
  ) -> Result<(), ResourceError> {
    let shared = self.shared.clone();
    loop {
      let notified = shared.space_notify.notified();
      {
        let mut data = shared.data.lock().await;
        StreamResourceTable::refresh(&mut data);
        StreamResourceTable::check_owner(&data, principal)?;
        if let Some(term) = &data.terminal {
          return match term {
            StreamTerminalState::Cancelled => Err(ResourceError::Cancelled),
            _ => Err(ResourceError::Closed),
          };
        }
        if !data.writer_open {
          return Err(ResourceError::Closed);
        }
        if !frame.kind_matches(data.kind) {
          return Err(ResourceError::WrongDirection);
        }
        if matches!(frame, StreamFrame::Terminal(_)) {
          return Err(ResourceError::Internal("use finish/fail/cancel for terminal".into()));
        }
        let nbytes = frame.byte_len();
        if nbytes > RESOURCE_MAX_CHUNK_BYTES {
          return Err(ResourceError::OutOfBounds);
        }
        if data.bytes_sent.saturating_add(nbytes) > data.max_bytes {
          return Err(ResourceError::Exhausted);
        }
        if !data.reader_open {
          data.set_terminal(StreamTerminalState::Cancelled);
          drop(data);
          shared.space_notify.notify_waiters();
          shared.data_notify.notify_waiters();
          return Err(ResourceError::Cancelled);
        }
        if data.buffer.len() < data.buffer_frames {
          data.buffer.push_back(frame);
          data.bytes_sent = data.bytes_sent.saturating_add(nbytes);
          drop(data);
          shared.data_notify.notify_waiters();
          return Ok(());
        }
      }
      tokio::select! {
        biased;
        _ = notified => continue,
        _ = cancel_cancelled(cancel) => return Err(ResourceError::Cancelled),
        _ = tokio::time::sleep(STREAM_BACKPRESSURE_WAIT) => {
          return Err(ResourceError::Internal("backpressure deadline".into()));
        }
        _ = sleep_until_deadline(deadline) => {
          return Err(ResourceError::Internal("request deadline".into()));
        }
      }
    }
  }

  /// Seal the writer with `finished`. Exactly one terminal transition is allowed.
  pub async fn finish(&mut self, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    self.terminate(principal, StreamTerminalState::Finished).await
  }

  /// Seal the writer with `failed(code)`.
  pub async fn fail(&mut self, principal: &PluginPrincipal, code: &str) -> Result<(), ResourceError> {
    self
      .terminate(principal, StreamTerminalState::failed_sanitized(code))
      .await
  }

  /// Force-cancel the writer if not already terminal (best-effort cleanup on pump drop/error).
  /// Async so it never blocks the Tokio runtime thread (`blocking_lock` is forbidden inside the
  /// async runtime). The pump task calls this after its loop exits; terminal is idempotent.
  pub async fn cancel(&mut self) {
    {
      let mut data = self.shared.data.lock().await;
      if data.terminal.is_none() {
        data.set_terminal(StreamTerminalState::Cancelled);
      } else {
        data.writer_open = false;
      }
    }
    self.shared.data_notify.notify_waiters();
    self.shared.space_notify.notify_waiters();
  }

  async fn terminate(
    &mut self,
    principal: &PluginPrincipal,
    terminal: StreamTerminalState,
  ) -> Result<(), ResourceError> {
    let mut data = self.shared.data.lock().await;
    StreamResourceTable::refresh(&mut data);
    StreamResourceTable::check_owner(&data, principal)?;
    if !data.writer_open {
      return Err(ResourceError::Closed);
    }
    if data.terminal.is_some() {
      return Err(ResourceError::Closed);
    }
    data.set_terminal(terminal);
    drop(data);
    self.shared.data_notify.notify_waiters();
    self.shared.space_notify.notify_waiters();
    Ok(())
  }
}

/// Bounded wall-clock budget for joining broker pump/transport tasks on reader close. The tasks
/// observe the transport cancel token and the request cancel token, so they terminate promptly;
/// this bound only guards against a misbehaving transport that ignores cancellation.
pub const STREAM_PUMP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

/// Supervisor for a broker-backed network-binary stream pump. Owns the transport-specific cancel
/// token and the spawned transport/pump task handles so the host can stop the upstream transport
/// and join its cleanup when the reader is closed/cancelled, instead of detaching the tasks.
///
/// - `cancel()` fires the transport token (sync, safe from `Drop`/sync table clear paths).
/// - `shutdown()` fires the token and awaits both tasks within [`STREAM_PUMP_SHUTDOWN_TIMEOUT`].
///
/// The same transport token is stored in [`StreamShared`] so any terminal transition (reader
/// close/cancel/expiry/fail) also stops the transport, even without an explicit supervisor call.
pub struct StreamPumpSupervisor {
  transport_cancel: CancelToken,
  join_handles: std::sync::Mutex<Option<(tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>)>>,
}

impl StreamPumpSupervisor {
  /// Construct a supervisor around a transport cancel token. The token is also stored in the
  /// stream's shared state so terminal transitions fire it.
  pub fn new(transport_cancel: CancelToken) -> Self {
    Self {
      transport_cancel,
      join_handles: std::sync::Mutex::new(None),
    }
  }

  /// Clone of the transport cancel token (passed to `transport.stream`).
  pub fn transport_cancel(&self) -> CancelToken {
    self.transport_cancel.clone()
  }

  /// Install the spawned transport and pump task handles for later joining.
  pub fn install_handles(&self, transport: tokio::task::JoinHandle<()>, pump: tokio::task::JoinHandle<()>) {
    *self.join_handles.lock().expect("pump supervisor poisoned") = Some((transport, pump));
  }

  /// Fire the transport cancel token so the upstream transport self-terminates. Sync-safe;
  /// callers that cannot await must use [`Self::abort`] instead of dropping task handles.
  pub fn cancel(&self) {
    self.transport_cancel.cancel();
  }

  /// Cancel and explicitly abort all owned tasks. This is intentionally synchronous for table
  /// clear and `Drop` paths where joining would block the runtime thread. `abort` schedules
  /// cancellation before the handles are released, unlike dropping a JoinHandle which detaches.
  pub fn abort(&self) {
    self.transport_cancel.cancel();
    if let Some((transport, pump)) = self.join_handles.lock().expect("pump supervisor poisoned").take() {
      transport.abort();
      pump.abort();
    }
  }

  /// Fire the transport cancel token and await both tasks within [`STREAM_PUMP_SHUTDOWN_TIMEOUT`].
  /// If either task ignores cooperative cancellation, retain the mutable handles, abort only the
  /// unfinished task(s), and await their aborted completion. Completion is tracked separately so
  /// a task whose JoinHandle was already observed is never polled a second time after timeout.
  pub async fn shutdown(&self) {
    self.transport_cancel.cancel();
    let handles = self.join_handles.lock().expect("pump supervisor poisoned").take();
    if let Some((mut transport, mut pump)) = handles {
      let shutdown_deadline = tokio::time::Instant::now() + STREAM_PUMP_SHUTDOWN_TIMEOUT;
      let mut transport_finished = false;
      let mut pump_finished = false;
      while !transport_finished || !pump_finished {
        tokio::select! {
          result = &mut transport, if !transport_finished => {
            report_pump_task_result(result, "transport");
            transport_finished = true;
          }
          result = &mut pump, if !pump_finished => {
            report_pump_task_result(result, "pump");
            pump_finished = true;
          }
          _ = tokio::time::sleep_until(shutdown_deadline) => break,
        }
      }
      if !transport_finished {
        transport.abort();
        await_pump_task(&mut transport, "transport after abort").await;
      }
      if !pump_finished {
        pump.abort();
        await_pump_task(&mut pump, "pump after abort").await;
      }
    }
  }
}

impl Drop for StreamPumpSupervisor {
  fn drop(&mut self) {
    self.abort();
  }
}

/// Await a supervised task and report unexpected task termination without exposing transport
/// details to guests. Aborted tasks are expected during synchronous cleanup and stay quiet.
async fn await_pump_task(handle: &mut tokio::task::JoinHandle<()>, task_name: &str) {
  report_pump_task_result(handle.await, task_name);
}

/// Report a completed task result exactly once. The supervisor tracks completion flags before
/// calling this helper, which avoids polling a completed JoinHandle again after a timeout.
fn report_pump_task_result(result: Result<(), tokio::task::JoinError>, task_name: &str) {
  if let Err(error) = result {
    if !error.is_cancelled() {
      log::warn!("stream pump {task_name} task ended unexpectedly");
    }
  }
}

pub(crate) async fn sleep_until_deadline(deadline: Option<Instant>) {
  if let Some(deadline) = deadline {
    let now = Instant::now();
    if deadline > now {
      tokio::time::sleep(deadline - now).await;
    }
  } else {
    std::future::pending::<()>().await;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::cancel::CancelToken;
  use crate::domain::plugin_resource::ResourceDirection;
  use crate::domain::runtime_plugin::{
    CapabilityId, ExecutionGrantSet, PackageDigest, PackageIdentity, PluginId, RuntimeIdentity, SemVerVersion,
  };
  use uuid::Uuid;

  fn principal(request: &str) -> PluginPrincipal {
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
          .unwrap(),
      }),
      PluginId::parse("com.langnext.stream-test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("translate.text@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    grant.principal_for_request("translate.text@1", request).unwrap()
  }

  fn params(p: &PluginPrincipal) -> ResourceCreateParams {
    ResourceCreateParams {
      owner: ResourceOwner::from_principal(p),
      direction: ResourceDirection::Output,
      content_type: Some("application/octet-stream".into()),
      max_bytes: 64,
      expires_at: None,
      cancel: CancelToken::new(),
    }
  }

  #[tokio::test]
  async fn ordering_backpressure_terminal_and_cross_owner() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-s1");
    let (w, r) = table.create(params(&p), StreamKind::NetworkBinary, Some(1)).unwrap();

    table
      .send(w, &p, StreamFrame::NetworkBinary(b"a".to_vec()), None, None)
      .await
      .unwrap();

    let table_ref = &table;
    let p2 = p.clone();
    let send_fut = async {
      table_ref
        .send(w, &p2, StreamFrame::NetworkBinary(b"b".to_vec()), None, None)
        .await
    };
    let recv_fut = async {
      let first = table_ref.receive(r, &p2, None, None).await.unwrap();
      assert_eq!(first, Some(StreamFrame::NetworkBinary(b"a".to_vec())));
      let second = table_ref.receive(r, &p2, None, None).await.unwrap();
      assert_eq!(second, Some(StreamFrame::NetworkBinary(b"b".to_vec())));
    };
    let (send_res, _) = tokio::join!(send_fut, recv_fut);
    send_res.unwrap();

    table.finish(w, &p).await.unwrap();
    let term = table.receive(r, &p, None, None).await.unwrap();
    assert_eq!(term, Some(StreamFrame::Terminal(StreamTerminalState::Finished)));
    assert_eq!(table.state(r, &p).await.unwrap(), Some(StreamTerminalState::Finished));

    let other = principal("req-other");
    assert!(matches!(
      table.receive(r, &other, None, None).await,
      Err(ResourceError::NotOwned)
    ));
  }

  #[tokio::test]
  async fn consumer_disconnect_cancels_producer() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-s2");
    let (w, r) = table.create(params(&p), StreamKind::NetworkBinary, Some(4)).unwrap();
    table.reader_close(r, &p).await.unwrap();
    let err = table
      .send(w, &p, StreamFrame::NetworkBinary(b"x".to_vec()), None, None)
      .await
      .unwrap_err();
    assert!(matches!(err, ResourceError::Cancelled));
  }

  #[tokio::test]
  async fn cancellation_from_reader() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-s3");
    let (w, r) = table.create(params(&p), StreamKind::NetworkBinary, Some(4)).unwrap();
    table.cancel(r, &p).await.unwrap();
    assert!(matches!(
      table
        .send(w, &p, StreamFrame::NetworkBinary(b"x".to_vec()), None, None)
        .await,
      Err(ResourceError::Cancelled)
    ));
  }

  #[tokio::test]
  async fn mixed_kind_rejected() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-s4");
    let (w, _r) = table.create(params(&p), StreamKind::NetworkBinary, Some(4)).unwrap();
    let err = table
      .send(w, &p, StreamFrame::LlmDelta(LlmDelta::Text("hi".into())), None, None)
      .await
      .unwrap_err();
    assert!(matches!(err, ResourceError::WrongDirection));
  }

  #[tokio::test]
  async fn request_cleanup() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-s5");
    let _ = table.create(params(&p), StreamKind::NetworkBinary, Some(2)).unwrap();
    assert_eq!(table.writer_count(), 1);
    table.remove_for_request(p.request_id().as_str());
    assert_eq!(table.writer_count(), 0);
    assert_eq!(table.reader_count(), 0);
  }

  /// Every typed LLM delta variant (text, reasoning, tool-call, complete) must round-trip
  /// losslessly through the domain StreamFrame representation. The host never encodes arbitrary
  /// JSON then guesses on receive: each variant is preserved as its exact typed structure.
  #[tokio::test]
  async fn llm_delta_variants_round_trip_losslessly() {
    use crate::domain::plugin_resource::{LlmCompletionStatus, LlmDelta as DomainLlmDelta, LlmToolCallDelta};
    let mut table = StreamResourceTable::new();
    let p = principal("req-llm-delta");
    let (w, r) = table.create(params(&p), StreamKind::LlmDelta, Some(8)).unwrap();

    let deltas = vec![
      DomainLlmDelta::Text("hello world".into()),
      DomainLlmDelta::Reasoning("thinking step".into()),
      DomainLlmDelta::ToolCall(LlmToolCallDelta {
        id: "call-1".into(),
        name: "search".into(),
        arguments_json: b"{\"q\":\"rust\"}".to_vec(),
      }),
      DomainLlmDelta::Complete(LlmCompletionStatus::Stop),
      DomainLlmDelta::Complete(LlmCompletionStatus::Length),
      DomainLlmDelta::Complete(LlmCompletionStatus::ToolCalls),
    ];
    for delta in &deltas {
      table
        .send(w, &p, StreamFrame::LlmDelta(delta.clone()), None, None)
        .await
        .unwrap();
    }
    for expected in &deltas {
      let received = table.receive(r, &p, None, None).await.unwrap().unwrap();
      match (received, expected) {
        (StreamFrame::LlmDelta(got), DomainLlmDelta::Text(exp)) => {
          assert!(
            matches!(got, DomainLlmDelta::Text(ref t) if t == exp),
            "text mismatch: {got:?}"
          );
        }
        (StreamFrame::LlmDelta(got), DomainLlmDelta::Reasoning(exp)) => {
          assert!(
            matches!(got, DomainLlmDelta::Reasoning(ref t) if t == exp),
            "reasoning mismatch: {got:?}"
          );
        }
        (StreamFrame::LlmDelta(got), DomainLlmDelta::ToolCall(exp)) => match got {
          DomainLlmDelta::ToolCall(tc) => {
            assert_eq!(tc.id, exp.id);
            assert_eq!(tc.name, exp.name);
            assert_eq!(tc.arguments_json, exp.arguments_json);
          }
          other => panic!("tool-call mismatch: {other:?}"),
        },
        (StreamFrame::LlmDelta(got), DomainLlmDelta::Complete(exp)) => {
          assert!(
            matches!(got, DomainLlmDelta::Complete(ref s) if s == exp),
            "complete mismatch: {got:?}"
          );
        }
        (other, _) => panic!("unexpected frame: {other:?}"),
      }
    }
    table.finish(w, &p).await.unwrap();
    let term = table.receive(r, &p, None, None).await.unwrap().unwrap();
    assert_eq!(term, StreamFrame::Terminal(StreamTerminalState::Finished));
  }

  /// Cancellation must be prompt while the producer is blocked under backpressure: the request
  /// CancelToken is awaited directly in the send select, so the blocked send wakes immediately.
  #[tokio::test]
  async fn cancellation_wakes_blocked_producer_under_backpressure() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-cancel-producer");
    let (w, _r) = table.create(params(&p), StreamKind::NetworkBinary, Some(1)).unwrap();
    // Fill the single-frame buffer so the next send blocks under backpressure.
    table
      .send(w, &p, StreamFrame::NetworkBinary(b"a".to_vec()), None, None)
      .await
      .unwrap();

    let cancel = CancelToken::new();
    let cancel_clone = cancel.clone();
    let table_ref = &table;
    let p_clone = p.clone();
    let send_fut = async move {
      table_ref
        .send(
          w,
          &p_clone,
          StreamFrame::NetworkBinary(b"b".to_vec()),
          None,
          Some(&cancel_clone),
        )
        .await
    };

    // Race the blocked send against a short delay + cancel. The send must return promptly after
    // cancel, not wait for STREAM_BACKPRESSURE_WAIT (30s).
    let start = std::time::Instant::now();
    tokio::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
      cancel.cancel();
    });
    let result = send_fut.await;
    let elapsed = start.elapsed();
    assert!(matches!(result, Err(ResourceError::Cancelled)), "got {result:?}");
    assert!(
      elapsed < std::time::Duration::from_secs(5),
      "cancel must be prompt, took {elapsed:?}"
    );
  }

  /// Cancellation must be prompt while the consumer is blocked waiting for data: the request
  /// CancelToken is awaited directly in the receive select.
  #[tokio::test]
  async fn cancellation_wakes_blocked_consumer_waiting_for_data() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-cancel-consumer");
    let (_w, r) = table.create(params(&p), StreamKind::NetworkBinary, Some(4)).unwrap();

    let cancel = CancelToken::new();
    let cancel_clone = cancel.clone();
    let table_ref = &table;
    let p_clone = p.clone();
    let recv_fut = async move { table_ref.receive(r, &p_clone, None, Some(&cancel_clone)).await };

    let start = std::time::Instant::now();
    tokio::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
      cancel.cancel();
    });
    let result = recv_fut.await;
    let elapsed = start.elapsed();
    assert!(matches!(result, Err(ResourceError::Cancelled)), "got {result:?}");
    assert!(
      elapsed < std::time::Duration::from_secs(5),
      "cancel must be prompt, took {elapsed:?}"
    );
  }

  const TASK_ABORT_WAIT: Duration = Duration::from_secs(1);

  struct AbortProbe(Arc<std::sync::atomic::AtomicBool>);

  impl Drop for AbortProbe {
    fn drop(&mut self) {
      self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
  }

  fn spawn_stubborn_task(
    started: tokio::sync::oneshot::Sender<()>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
  ) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
      let _probe = AbortProbe(aborted);
      let _ = started.send(());
      std::future::pending::<()>().await;
    })
  }

  async fn install_stubborn_network_tasks(
    table: &mut StreamResourceTable,
    principal: &PluginPrincipal,
  ) -> (
    ResourceId,
    Arc<std::sync::atomic::AtomicBool>,
    Arc<std::sync::atomic::AtomicBool>,
  ) {
    let (_writer, mut reader) = StreamResourceTable::create_network_binary_pair(params(principal)).unwrap();
    let transport_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pump_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (transport_started_tx, transport_started_rx) = tokio::sync::oneshot::channel();
    let (pump_started_tx, pump_started_rx) = tokio::sync::oneshot::channel();
    let transport_task = spawn_stubborn_task(transport_started_tx, transport_aborted.clone());
    let pump_task = spawn_stubborn_task(pump_started_tx, pump_aborted.clone());
    reader.install_pump_handles(transport_task, pump_task);
    let reader_id = table.adopt_reader(reader).unwrap();
    transport_started_rx.await.expect("transport task started");
    pump_started_rx.await.expect("pump task started");
    (reader_id, transport_aborted, pump_aborted)
  }

  async fn assert_aborted(probe: &Arc<std::sync::atomic::AtomicBool>, task_name: &str) {
    tokio::time::timeout(TASK_ABORT_WAIT, async {
      while !probe.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::task::yield_now().await;
      }
    })
    .await
    .unwrap_or_else(|_| panic!("{task_name} task was not aborted"));
  }

  #[tokio::test(start_paused = true)]
  async fn async_reader_close_aborts_stubborn_tasks_after_shutdown_timeout() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-stubborn-close");
    let (reader_id, transport_aborted, pump_aborted) = install_stubborn_network_tasks(&mut table, &p).await;

    table.reader_close(reader_id, &p).await.unwrap();

    assert_aborted(&transport_aborted, "transport").await;
    assert_aborted(&pump_aborted, "pump").await;
  }

  #[tokio::test(start_paused = true)]
  async fn shutdown_does_not_repoll_a_completed_task_after_timeout() {
    let pump_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (transport_started_tx, transport_started_rx) = tokio::sync::oneshot::channel();
    let (pump_started_tx, pump_started_rx) = tokio::sync::oneshot::channel();
    let supervisor = StreamPumpSupervisor::new(CancelToken::new());
    let completed_transport = tokio::spawn(async move {
      let _ = transport_started_tx.send(());
    });
    let stubborn_pump = spawn_stubborn_task(pump_started_tx, pump_aborted.clone());
    supervisor.install_handles(completed_transport, stubborn_pump);
    transport_started_rx.await.expect("transport task started");
    pump_started_rx.await.expect("pump task started");

    supervisor.shutdown().await;

    assert_aborted(&pump_aborted, "stubborn pump").await;
  }

  #[tokio::test]
  async fn request_cleanup_aborts_stubborn_tasks() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-stubborn-request-cleanup");
    let (_reader_id, transport_aborted, pump_aborted) = install_stubborn_network_tasks(&mut table, &p).await;

    table.remove_for_request(p.request_id().as_str());

    assert_aborted(&transport_aborted, "request-cleanup transport").await;
    assert_aborted(&pump_aborted, "request-cleanup pump").await;
  }

  #[tokio::test]
  async fn synchronous_clear_and_supervisor_drop_abort_stubborn_tasks() {
    let mut table = StreamResourceTable::new();
    let p = principal("req-stubborn-clear");
    let (_reader_id, transport_aborted, pump_aborted) = install_stubborn_network_tasks(&mut table, &p).await;

    table.clear();

    assert_aborted(&transport_aborted, "table-clear transport").await;
    assert_aborted(&pump_aborted, "table-clear pump").await;

    let transport_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pump_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (transport_started_tx, transport_started_rx) = tokio::sync::oneshot::channel();
    let (pump_started_tx, pump_started_rx) = tokio::sync::oneshot::channel();
    let supervisor = StreamPumpSupervisor::new(CancelToken::new());
    supervisor.install_handles(
      spawn_stubborn_task(transport_started_tx, transport_aborted.clone()),
      spawn_stubborn_task(pump_started_tx, pump_aborted.clone()),
    );
    transport_started_rx.await.expect("drop transport task started");
    pump_started_rx.await.expect("drop pump task started");
    drop(supervisor);

    assert_aborted(&transport_aborted, "supervisor-drop transport").await;
    assert_aborted(&pump_aborted, "supervisor-drop pump").await;
  }
}
