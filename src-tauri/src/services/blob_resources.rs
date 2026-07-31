// ABOUTME: Host-owned bounded blob lifecycle: create/write/read/close/discard with ownership checks.
// ABOUTME: Bytes stay in memory under absolute caps; temp-file backing threshold is documented only.
use crate::domain::plugin_resource::{
  BLOB_TEMP_FILE_BACKING_THRESHOLD_BYTES, MediaMetadata, RESOURCE_MAX_CHUNK_BYTES, ResourceCreateParams,
  ResourceDirection, ResourceError, ResourceId, ResourceLifecycle, ResourceOwner,
};
use crate::domain::runtime_plugin::PluginPrincipal;
use std::collections::HashMap;
use std::time::Instant;

/// Host blob table for one request store. Guests only ever see opaque table indices, never ids.
#[derive(Default)]
pub struct BlobResourceTable {
  entries: HashMap<ResourceId, BlobEntry>,
}

/// Internal blob entry. Paths and pointers are never exposed.
struct BlobEntry {
  owner: ResourceOwner,
  direction: ResourceDirection,
  content_type: Option<String>,
  max_bytes: u64,
  data: Vec<u8>,
  lifecycle: ResourceLifecycle,
  expires_at: Instant,
  /// Cancel token shared with the request; cancel makes subsequent ops fail.
  cancel_check: Box<dyn Fn() -> bool + Send + Sync>,
}

impl BlobResourceTable {
  pub fn new() -> Self {
    Self {
      entries: HashMap::new(),
    }
  }

  /// Documented threshold above which a later release may switch to host-private temp backing.
  pub fn temp_file_backing_threshold_bytes() -> u64 {
    BLOB_TEMP_FILE_BACKING_THRESHOLD_BYTES
  }

  /// Create a bounded blob owned by `params.owner`. Returns the opaque resource id.
  pub fn create(&mut self, params: ResourceCreateParams) -> Result<ResourceId, ResourceError> {
    params.validate()?;
    let id = ResourceId::generate();
    let expires_at = params.effective_expiry();
    let cancel = params.cancel.clone();
    let entry = BlobEntry {
      owner: params.owner,
      direction: params.direction,
      content_type: params.content_type,
      max_bytes: params.max_bytes,
      data: Vec::new(),
      lifecycle: ResourceLifecycle::Open,
      expires_at,
      cancel_check: Box::new(move || cancel.is_cancelled()),
    };
    self.entries.insert(id, entry);
    Ok(id)
  }

  /// Create a blob pre-filled with `bytes` (host producer path, e.g. broker bytes mode).
  pub fn create_with_bytes(
    &mut self,
    params: ResourceCreateParams,
    bytes: Vec<u8>,
  ) -> Result<ResourceId, ResourceError> {
    params.validate()?;
    if bytes.len() as u64 > params.max_bytes {
      return Err(ResourceError::Exhausted);
    }
    let id = ResourceId::generate();
    let expires_at = params.effective_expiry();
    let cancel = params.cancel.clone();
    let entry = BlobEntry {
      owner: params.owner,
      direction: params.direction,
      content_type: params.content_type,
      max_bytes: params.max_bytes,
      data: bytes,
      lifecycle: ResourceLifecycle::Closed,
      expires_at,
      cancel_check: Box::new(move || cancel.is_cancelled()),
    };
    self.entries.insert(id, entry);
    Ok(id)
  }

  /// Write `bytes` at `offset`. Returns bytes accepted. Output direction only while open.
  pub fn write(
    &mut self,
    id: ResourceId,
    principal: &PluginPrincipal,
    offset: u64,
    bytes: &[u8],
  ) -> Result<u64, ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    if entry.direction != ResourceDirection::Output {
      return Err(ResourceError::WrongDirection);
    }
    if !entry.lifecycle.allows_write() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    if bytes.len() as u64 > RESOURCE_MAX_CHUNK_BYTES {
      return Err(ResourceError::OutOfBounds);
    }
    let end = offset
      .checked_add(bytes.len() as u64)
      .ok_or(ResourceError::OutOfBounds)?;
    if end > entry.max_bytes {
      return Err(ResourceError::Exhausted);
    }
    let offset_usize = usize::try_from(offset).map_err(|_| ResourceError::OutOfBounds)?;
    if offset_usize > entry.data.len() {
      // Sparse writes beyond current length are rejected (no implicit zero-fill growth tricks).
      return Err(ResourceError::OutOfBounds);
    }
    if offset_usize == entry.data.len() {
      entry.data.extend_from_slice(bytes);
    } else {
      let end_usize = usize::try_from(end).map_err(|_| ResourceError::OutOfBounds)?;
      if end_usize > entry.data.len() {
        entry.data.resize(end_usize, 0);
      }
      entry.data[offset_usize..end_usize].copy_from_slice(bytes);
    }
    Ok(bytes.len() as u64)
  }

  /// Read up to `max_bytes` starting at `offset`. Input direction, or closed output for host drain.
  pub fn read(
    &mut self,
    id: ResourceId,
    principal: &PluginPrincipal,
    offset: u64,
    max_bytes: u64,
  ) -> Result<Vec<u8>, ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    // Guest input blobs are readable; output blobs become readable after close (host drain / guest verify).
    let readable = match entry.direction {
      ResourceDirection::Input => true,
      ResourceDirection::Output => matches!(entry.lifecycle, ResourceLifecycle::Closed | ResourceLifecycle::Open),
    };
    // Terminal lifecycle (expired/cancelled/discarded) takes precedence over direction so a
    // released output blob reports Closed/Cancelled rather than WrongDirection.
    if !entry.lifecycle.allows_read() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    if !readable {
      return Err(ResourceError::WrongDirection);
    }
    if max_bytes == 0 {
      return Ok(Vec::new());
    }
    let take = max_bytes.min(RESOURCE_MAX_CHUNK_BYTES);
    let offset_usize = usize::try_from(offset).map_err(|_| ResourceError::OutOfBounds)?;
    if offset_usize >= entry.data.len() {
      return Ok(Vec::new());
    }
    let end = offset_usize.saturating_add(take as usize).min(entry.data.len());
    Ok(entry.data[offset_usize..end].to_vec())
  }

  /// Current accepted byte length.
  pub fn length(&mut self, id: ResourceId, principal: &PluginPrincipal) -> Result<u64, ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    if entry.lifecycle.is_terminal_release() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    Ok(entry.data.len() as u64)
  }

  /// Media metadata (content-type + byte-length).
  pub fn metadata(&mut self, id: ResourceId, principal: &PluginPrincipal) -> Result<MediaMetadata, ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    if entry.lifecycle.is_terminal_release() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    Ok(MediaMetadata {
      content_type: entry.content_type.clone(),
      byte_length: Some(entry.data.len() as u64),
    })
  }

  /// Seal an output blob (terminal for writes; reads still allowed until discard).
  pub fn close(&mut self, id: ResourceId, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    if entry.lifecycle.is_terminal_release() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    if matches!(entry.lifecycle, ResourceLifecycle::Closed) {
      return Err(ResourceError::Closed);
    }
    entry.lifecycle = ResourceLifecycle::Closed;
    Ok(())
  }

  /// Hard-release a blob. Subsequent ops fail; entry may be removed.
  pub fn discard(&mut self, id: ResourceId, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    // Discard still requires ownership so cross-owner discard cannot probe existence beyond NotOwned.
    if !entry.owner.matches_principal(principal) {
      return Err(ResourceError::NotOwned);
    }
    entry.lifecycle = ResourceLifecycle::Discarded;
    entry.data.clear();
    entry.data.shrink_to_fit();
    self.entries.remove(&id);
    Ok(())
  }

  /// Host-only: take all bytes from a closed (or open) blob owned by principal, then discard.
  pub fn take_bytes(&mut self, id: ResourceId, principal: &PluginPrincipal) -> Result<Vec<u8>, ResourceError> {
    let entry = self.entries.get_mut(&id).ok_or(ResourceError::NotOwned)?;
    Self::refresh_lifecycle(entry);
    Self::check_owner(entry, principal)?;
    if !entry.lifecycle.allows_read() {
      return Self::lifecycle_error_as(&entry.lifecycle);
    }
    let bytes = std::mem::take(&mut entry.data);
    entry.lifecycle = ResourceLifecycle::Discarded;
    self.entries.remove(&id);
    Ok(bytes)
  }

  /// Drop every resource for a finished request (request completion / store drop).
  pub fn remove_for_request(&mut self, request_id: &str) {
    self.entries.retain(|_, entry| entry.owner.request_id() != request_id);
  }

  /// Drop all resources (app shutdown / store drop).
  pub fn clear(&mut self) {
    self.entries.clear();
  }

  pub fn len(&self) -> usize {
    self.entries.len()
  }

  pub fn is_empty(&self) -> bool {
    self.entries.is_empty()
  }

  fn check_owner(entry: &BlobEntry, principal: &PluginPrincipal) -> Result<(), ResourceError> {
    if entry.owner.matches_principal(principal) {
      Ok(())
    } else {
      Err(ResourceError::NotOwned)
    }
  }

  fn refresh_lifecycle(entry: &mut BlobEntry) {
    if entry.lifecycle.is_terminal_release() {
      return;
    }
    if (entry.cancel_check)() {
      entry.lifecycle = ResourceLifecycle::Cancelled;
      entry.data.clear();
      return;
    }
    if Instant::now() >= entry.expires_at {
      entry.lifecycle = ResourceLifecycle::Expired;
      entry.data.clear();
    }
  }

  fn lifecycle_error_as<T>(lifecycle: &ResourceLifecycle) -> Result<T, ResourceError> {
    match lifecycle {
      ResourceLifecycle::Cancelled => Err(ResourceError::Cancelled),
      ResourceLifecycle::Expired | ResourceLifecycle::Closed | ResourceLifecycle::Discarded => {
        Err(ResourceError::Closed)
      }
      ResourceLifecycle::Open => Err(ResourceError::Internal("unexpected open lifecycle error".into())),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::cancel::CancelToken;
  use crate::domain::runtime_plugin::{
    AuthPolicyId, CapabilityId, EndpointId, ExecutionGrantSet, HttpMethod, HttpsOrigin, NetworkGrantEntry,
    PackageDigest, PackageIdentity, PluginId, ResourceLimits, RuntimeIdentity, SemVerVersion,
  };
  use std::time::Duration;
  use uuid::Uuid;

  fn principal() -> PluginPrincipal {
    let grant = ExecutionGrantSet::initial(
      Uuid::nil(),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
          .unwrap(),
      }),
      PluginId::parse("com.langnext.test").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("speech.synthesize@1").unwrap()],
      vec![NetworkGrantEntry::new(
        CapabilityId::parse("speech.synthesize@1").unwrap(),
        EndpointId::parse("tts-api").unwrap(),
        HttpsOrigin::parse("https://example.com").unwrap(),
        HttpMethod::Post,
        AuthPolicyId::parse("host.none.v1").unwrap(),
        ResourceLimits::default(),
      )],
      vec![],
    )
    .unwrap();
    grant
      .principal_for_request("speech.synthesize@1", "req-blob-1")
      .unwrap()
  }

  fn other_principal() -> PluginPrincipal {
    let grant = ExecutionGrantSet::initial(
      Uuid::from_u128(2),
      RuntimeIdentity::Package(PackageIdentity {
        package_digest: PackageDigest::parse("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
          .unwrap(),
      }),
      PluginId::parse("com.langnext.other").unwrap(),
      SemVerVersion::parse("1.0.0").unwrap(),
      vec![CapabilityId::parse("speech.synthesize@1").unwrap()],
      vec![],
      vec![],
    )
    .unwrap();
    grant.principal_for_request("speech.synthesize@1", "req-other").unwrap()
  }

  fn params(owner: ResourceOwner, direction: ResourceDirection, max_bytes: u64) -> ResourceCreateParams {
    ResourceCreateParams {
      owner,
      direction,
      content_type: Some("audio/mpeg".into()),
      max_bytes,
      expires_at: None,
      cancel: CancelToken::new(),
    }
  }

  #[test]
  fn ownership_cap_chunk_close_cancel_and_cleanup() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let id = table
      .create(params(owner.clone(), ResourceDirection::Output, 16))
      .unwrap();

    // Cap: writing beyond max fails.
    assert!(matches!(
      table.write(id, &p, 0, &[0u8; 17]),
      Err(ResourceError::Exhausted)
    ));

    // Chunk cap.
    let big = vec![1u8; (RESOURCE_MAX_CHUNK_BYTES as usize) + 1];
    assert!(matches!(table.write(id, &p, 0, &big), Err(ResourceError::OutOfBounds)));

    assert_eq!(table.write(id, &p, 0, b"hello").unwrap(), 5);
    assert_eq!(table.length(id, &p).unwrap(), 5);
    let meta = table.metadata(id, &p).unwrap();
    assert_eq!(meta.content_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(meta.byte_length, Some(5));

    // Cross-owner denied without revealing owner data.
    let other = other_principal();
    assert!(matches!(table.read(id, &other, 0, 5), Err(ResourceError::NotOwned)));

    table.close(id, &p).unwrap();
    assert!(matches!(table.write(id, &p, 5, b"x"), Err(ResourceError::Closed)));
    assert_eq!(table.read(id, &p, 0, 5).unwrap(), b"hello");

    // Discard is terminal.
    table.discard(id, &p).unwrap();
    assert!(matches!(table.read(id, &p, 0, 5), Err(ResourceError::NotOwned)));
  }

  #[test]
  fn expiry_and_cancel_fail_subsequent_ops() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let cancel = CancelToken::new();
    let id = table
      .create(ResourceCreateParams {
        owner: owner.clone(),
        direction: ResourceDirection::Output,
        content_type: None,
        max_bytes: 32,
        expires_at: Some(Instant::now()),
        cancel: cancel.clone(),
      })
      .unwrap();
    // Allow the clock to advance past the exact creation Instant.
    std::thread::sleep(Duration::from_millis(5));
    assert!(matches!(table.read(id, &p, 0, 2), Err(ResourceError::Closed)));

    let id2 = table
      .create(ResourceCreateParams {
        owner,
        direction: ResourceDirection::Output,
        content_type: None,
        max_bytes: 32,
        expires_at: None,
        cancel: cancel.clone(),
      })
      .unwrap();
    cancel.cancel();
    assert!(matches!(table.write(id2, &p, 0, b"x"), Err(ResourceError::Cancelled)));
  }

  #[test]
  fn request_cleanup_removes_owned_blobs() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let id = table.create(params(owner, ResourceDirection::Input, 8)).unwrap();
    assert_eq!(table.len(), 1);
    table.remove_for_request(p.request_id().as_str());
    assert!(table.is_empty());
    assert!(matches!(table.length(id, &p), Err(ResourceError::NotOwned)));
  }

  #[test]
  fn create_with_bytes_and_take_bytes() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let id = table
      .create_with_bytes(params(owner, ResourceDirection::Input, 16), b"mp3data".to_vec())
      .unwrap();
    let bytes = table.take_bytes(id, &p).unwrap();
    assert_eq!(bytes, b"mp3data");
    assert!(table.is_empty());
  }

  #[test]
  fn temp_file_threshold_is_documented() {
    assert!(BlobResourceTable::temp_file_backing_threshold_bytes() >= 8 * 1024 * 1024);
  }

  /// Atomic consume: take_bytes moves arbitrary binary out and removes the entry exactly once.
  /// Repeat consume fails safely (NotOwned) and the buffer is not left inaccessible.
  #[test]
  fn take_bytes_arbitrary_binary_removed_after_transfer() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    // Arbitrary binary including non-UTF-8 octets.
    let binary = vec![0xFFu8, 0xFE, 0xFD, 0x00, 0x01, 0x80, 0x7F, 0xC0];
    let id = table
      .create_with_bytes(
        params(ResourceOwner::from_principal(&p), ResourceDirection::Input, 32),
        binary.clone(),
      )
      .unwrap();
    // An unrelated entry to prove consume only removes the targeted one.
    let _other = table
      .create_with_bytes(
        params(ResourceOwner::from_principal(&p), ResourceDirection::Input, 8),
        vec![0u8; 4],
      )
      .unwrap();
    assert_eq!(table.len(), 2);
    let bytes = table.take_bytes(id, &p).unwrap();
    assert_eq!(bytes, binary);
    // Entry removed after transfer (no inaccessible buffer leak).
    assert!(matches!(table.take_bytes(id, &p), Err(ResourceError::NotOwned)));
    assert!(matches!(table.length(id, &p), Err(ResourceError::NotOwned)));
    // The other unrelated entry is untouched.
    assert_eq!(table.len(), 1);
  }

  /// Wrong-owner consume does not leak or remove the entry; the rightful owner can still take.
  #[test]
  fn take_bytes_wrong_owner_does_not_leak() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let binary = vec![0xABu8, 0xCD, 0x00, 0xFF];
    let id = table
      .create_with_bytes(params(owner, ResourceDirection::Input, 16), binary.clone())
      .unwrap();
    let other = other_principal();
    assert!(matches!(table.take_bytes(id, &other), Err(ResourceError::NotOwned)));
    // Entry is still present and consumable by the rightful owner.
    let bytes = table.take_bytes(id, &p).unwrap();
    assert_eq!(bytes, binary);
    assert!(table.is_empty());
  }

  /// A cancelled/expired blob cannot be consumed (bytes already cleared), proving errors do not
  /// leak partial buffers.
  #[test]
  fn take_bytes_cancelled_blob_fails_without_leak() {
    let mut table = BlobResourceTable::new();
    let p = principal();
    let owner = ResourceOwner::from_principal(&p);
    let cancel = CancelToken::new();
    let id = table
      .create_with_bytes(
        ResourceCreateParams {
          owner,
          direction: ResourceDirection::Input,
          content_type: None,
          max_bytes: 16,
          expires_at: None,
          cancel: cancel.clone(),
        },
        vec![1, 2, 3, 4],
      )
      .unwrap();
    cancel.cancel();
    // Cancelled blob: take_bytes fails (Cancelled) and returns no bytes.
    assert!(matches!(table.take_bytes(id, &p), Err(ResourceError::Cancelled)));
    // Entry remains but is terminal; a second take still fails (not a fresh buffer).
    assert!(matches!(table.take_bytes(id, &p), Err(ResourceError::Cancelled)));
  }
}
