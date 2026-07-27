// ABOUTME: Opaque OAuth token grants with in-memory cache keyed by instance/revision/scope.
// ABOUTME: Capability handlers receive grants without raw tokens; only the broker injects Bearer auth.
use crate::domain::cancel::CancelToken;
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

// Auth-policy constants and grant-request validation live in the host-owned auth_policies module.
pub use crate::services::auth_policies::{
  GOOGLE_CLOUD_TEXT_TO_SPEECH_SCOPE, GOOGLE_CLOUD_TRANSLATION_SCOPE, GOOGLE_CLOUD_VISION_SCOPE,
  GOOGLE_OAUTH_AUDIENCE_POLICY_ID, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID,
};
/// Safety skew subtracted from token expiry before reuse.
pub const TOKEN_EXPIRY_SAFETY_SKEW: Duration = Duration::from_secs(60);
/// Max concurrent cached grants retained in process memory.
const TOKEN_CACHE_MAX_ENTRIES: usize = 64;

/// Host-owned request for an opaque access-token grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenGrantRequest {
  pub instance_id: Uuid,
  pub capability_id: String,
  pub auth_driver_id: String,
  /// Normalized unique scopes (already sorted/deduped by caller or service).
  pub scopes: Vec<String>,
  pub audience_policy_id: String,
}

/// Opaque access token grant. Handlers must pass this to the network broker only.
pub struct TokenGrant {
  access_token: String,
  expires_at: Instant,
  instance_id: Uuid,
  credential_revision: i64,
  /// Capability authority for which this opaque handle was issued.
  capability_id: String,
  /// Host-owned token driver that issued this grant.
  auth_driver_id: String,
  /// Host-owned audience policy validated at issuance.
  audience_policy_id: String,
  scope_key: String,
}

impl TokenGrant {
  /// Apply Bearer auth into headers. Intended for network broker use only.
  pub(crate) fn apply_bearer_auth(&self, headers: &mut HashMap<String, String>) {
    headers.insert("Authorization".into(), format!("Bearer {}", self.access_token));
  }

  pub fn instance_id(&self) -> Uuid {
    self.instance_id
  }

  pub fn credential_revision(&self) -> i64 {
    self.credential_revision
  }

  pub(crate) fn capability_id(&self) -> &str {
    &self.capability_id
  }

  pub(crate) fn auth_driver_id(&self) -> &str {
    &self.auth_driver_id
  }

  pub(crate) fn audience_policy_id(&self) -> &str {
    &self.audience_policy_id
  }

  pub fn is_expired(&self, now: Instant) -> bool {
    now >= self.expires_at
  }
}

impl fmt::Debug for TokenGrant {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("TokenGrant")
      .field("instance_id", &self.instance_id)
      .field("credential_revision", &self.credential_revision)
      .field("capability_id", &self.capability_id)
      .field("auth_driver_id", &self.auth_driver_id)
      .field("audience_policy_id", &self.audience_policy_id)
      .field("scope_key", &self.scope_key)
      .field("expired", &self.is_expired(Instant::now()))
      .finish_non_exhaustive()
  }
}

/// Clock abstraction for cache expiry tests.
pub trait GrantClock: Send + Sync + 'static {
  fn now_instant(&self) -> Instant;
  fn now_unix_secs(&self) -> u64;
}

#[derive(Debug, Default)]
pub struct SystemGrantClock;

impl GrantClock for SystemGrantClock {
  fn now_instant(&self) -> Instant {
    Instant::now()
  }

  fn now_unix_secs(&self) -> u64 {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_secs())
      .unwrap_or(0)
  }
}

/// Loads SA credentials and exchanges JWT assertions for access tokens.
pub trait GoogleTokenExchanger: Send + Sync + 'static {
  fn exchange(
    &self,
    instance_id: Uuid,
    scopes: Vec<String>,
    now_unix_secs: u64,
    cancel: Option<CancelToken>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>>;
}

#[derive(Clone)]
pub struct ExchangedToken {
  pub access_token: String,
  pub expires_in: u64,
  pub credential_revision: i64,
}

impl fmt::Debug for ExchangedToken {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("ExchangedToken")
      .field("expires_in", &self.expires_in)
      .field("credential_revision", &self.credential_revision)
      .finish_non_exhaustive()
  }
}

#[derive(Clone)]
struct CacheEntry {
  access_token: String,
  expires_at: Instant,
  credential_revision: i64,
}

/// In-memory grant cache with per-instance eviction generations.
struct TokenCacheState {
  entries: HashMap<String, CacheEntry>,
  /// Bumped on every `evict_instance` so in-flight exchanges cannot re-insert.
  generations: HashMap<Uuid, u64>,
  /// Latest cached revision for `instance|scope` lookup without a vault read.
  latest_revision: HashMap<String, i64>,
}

impl TokenCacheState {
  fn new() -> Self {
    Self {
      entries: HashMap::new(),
      generations: HashMap::new(),
      latest_revision: HashMap::new(),
    }
  }

  fn generation(&self, instance_id: Uuid) -> u64 {
    self.generations.get(&instance_id).copied().unwrap_or(0)
  }
}

#[derive(Clone)]
pub struct TokenGrantService {
  cache: Arc<Mutex<TokenCacheState>>,
  clock: Arc<dyn GrantClock>,
  exchanger: Arc<dyn GoogleTokenExchanger>,
}

impl TokenGrantService {
  pub fn new(exchanger: Arc<dyn GoogleTokenExchanger>) -> Self {
    Self {
      cache: Arc::new(Mutex::new(TokenCacheState::new())),
      clock: Arc::new(SystemGrantClock),
      exchanger,
    }
  }

  pub fn with_clock(exchanger: Arc<dyn GoogleTokenExchanger>, clock: Arc<dyn GrantClock>) -> Self {
    Self {
      cache: Arc::new(Mutex::new(TokenCacheState::new())),
      clock,
      exchanger,
    }
  }

  /// Acquire a grant; uses cache when revision+scopes still valid.
  pub async fn acquire(
    &self,
    request: TokenGrantRequest,
    cancel: Option<&CancelToken>,
  ) -> Result<TokenGrant, CapabilityError> {
    crate::services::auth_policies::validate_grant_request(&request)?;
    let scope_key = normalize_scope_key(&request.scopes);
    let index_key = instance_scope_index_key(request.instance_id, &scope_key);

    let generation_before = {
      let state = self
        .cache
        .lock()
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "token cache lock poisoned"))?;
      if let Some(grant) = cached_grant_from_state(&state, &request, &scope_key, &index_key, self.clock.now_instant()) {
        return Ok(grant);
      }
      state.generation(request.instance_id)
    };

    if let Some(token) = cancel {
      if token.is_cancelled() {
        return Err(CapabilityError::new(
          CapabilityErrorCode::Cancelled,
          "token grant cancelled",
        ));
      }
    }

    let exchanged = self
      .exchanger
      .exchange(
        request.instance_id,
        request.scopes.clone(),
        self.clock.now_unix_secs(),
        cancel.cloned(),
      )
      .await?;

    if exchanged.access_token.trim().is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::Auth,
        "token exchange returned an empty access token",
      ));
    }

    let expires_in = exchanged.expires_in.max(1);
    let skew = TOKEN_EXPIRY_SAFETY_SKEW.min(Duration::from_secs(expires_in.saturating_sub(1)));
    let expires_at = self
      .clock
      .now_instant()
      .checked_add(Duration::from_secs(expires_in).saturating_sub(skew))
      .unwrap_or_else(|| self.clock.now_instant());

    let grant = TokenGrant {
      access_token: exchanged.access_token.clone(),
      expires_at,
      instance_id: request.instance_id,
      credential_revision: exchanged.credential_revision,
      capability_id: request.capability_id.clone(),
      auth_driver_id: request.auth_driver_id.clone(),
      audience_policy_id: request.audience_policy_id.clone(),
      scope_key: scope_key.clone(),
    };

    {
      let mut state = self
        .cache
        .lock()
        .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "token cache lock poisoned"))?;

      // Eviction or concurrent replace while exchange was in flight: never re-insert stale grants.
      if state.generation(request.instance_id) != generation_before {
        return Ok(grant);
      }

      // Do not let an older in-flight exchange overwrite a newer revision index.
      if let Some(&latest) = state.latest_revision.get(&index_key) {
        if latest > exchanged.credential_revision {
          return Ok(grant);
        }
      }

      let key = cache_key(request.instance_id, exchanged.credential_revision, &scope_key);
      if state.entries.len() >= TOKEN_CACHE_MAX_ENTRIES && !state.entries.contains_key(&key) {
        // Drop an arbitrary expired or first entry to keep the map bounded.
        let victim = state
          .entries
          .iter()
          .find(|(_, e)| e.expires_at <= self.clock.now_instant())
          .map(|(k, _)| k.clone())
          .or_else(|| state.entries.keys().next().cloned());
        if let Some(victim_key) = victim {
          if let Some(removed) = state.entries.remove(&victim_key) {
            // Best-effort index cleanup when the victim was the indexed revision.
            if let Some((inst_part, rest)) = victim_key.split_once('|') {
              if let Some((rev_part, scope_part)) = rest.split_once('|') {
                if let (Ok(inst), Ok(rev)) = (Uuid::parse_str(inst_part), rev_part.parse::<i64>()) {
                  let idx = instance_scope_index_key(inst, scope_part);
                  if state.latest_revision.get(&idx).copied() == Some(rev) && removed.credential_revision == rev {
                    state.latest_revision.remove(&idx);
                  }
                }
              }
            }
          }
        }
      }

      state.entries.insert(
        key,
        CacheEntry {
          access_token: exchanged.access_token,
          expires_at,
          credential_revision: exchanged.credential_revision,
        },
      );
      state.latest_revision.insert(index_key, exchanged.credential_revision);
    }

    Ok(grant)
  }

  /// Evict all cached grants for an integration instance (credential replace/clear/delete/disable).
  pub fn evict_instance(&self, instance_id: Uuid) {
    let entry_prefix = format!("{instance_id}|");
    let index_prefix = format!("{instance_id}|");
    if let Ok(mut state) = self.cache.lock() {
      state.entries.retain(|key, _| !key.starts_with(&entry_prefix));
      state.latest_revision.retain(|key, _| !key.starts_with(&index_prefix));
      let generation = state.generations.entry(instance_id).or_insert(0);
      *generation = generation.saturating_add(1);
    }
  }
}

fn cached_grant_from_state(
  state: &TokenCacheState,
  request: &TokenGrantRequest,
  scope_key: &str,
  index_key: &str,
  now: Instant,
) -> Option<TokenGrant> {
  let revision = *state.latest_revision.get(index_key)?;
  let entry = state
    .entries
    .get(&cache_key(request.instance_id, revision, scope_key))?;
  if entry.expires_at <= now {
    return None;
  }
  Some(TokenGrant {
    access_token: entry.access_token.clone(),
    expires_at: entry.expires_at,
    instance_id: request.instance_id,
    credential_revision: entry.credential_revision,
    capability_id: request.capability_id.clone(),
    auth_driver_id: request.auth_driver_id.clone(),
    audience_policy_id: request.audience_policy_id.clone(),
    scope_key: scope_key.to_string(),
  })
}

pub fn normalize_scope_key(scopes: &[String]) -> String {
  let mut normalized: Vec<String> = scopes
    .iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  normalized.sort();
  normalized.dedup();
  normalized.join(" ")
}

fn cache_key(instance_id: Uuid, credential_revision: i64, scope_key: &str) -> String {
  format!("{instance_id}|{credential_revision}|{scope_key}")
}

fn instance_scope_index_key(instance_id: Uuid, scope_key: &str) -> String {
  format!("{instance_id}|{scope_key}")
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID;
  use crate::services::google_cloud::{
    GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID as DETECT_LANGUAGE_CAPABILITY_ID,
    GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID as TRANSLATE_TEXT_CAPABILITY_ID,
  };
  use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
  use tokio::sync::Notify;

  struct FakeClock {
    instant: Mutex<Instant>,
    unix: Mutex<u64>,
  }

  impl FakeClock {
    fn new(unix: u64) -> Self {
      Self {
        instant: Mutex::new(Instant::now()),
        unix: Mutex::new(unix),
      }
    }

    fn advance(&self, by: Duration) {
      *self.instant.lock().unwrap() += by;
      *self.unix.lock().unwrap() += by.as_secs();
    }
  }

  impl GrantClock for FakeClock {
    fn now_instant(&self) -> Instant {
      *self.instant.lock().unwrap()
    }

    fn now_unix_secs(&self) -> u64 {
      *self.unix.lock().unwrap()
    }
  }

  struct FakeExchanger {
    calls: AtomicUsize,
    revision: AtomicI64,
    expires_in: u64,
    token: Mutex<String>,
    fail: bool,
  }

  impl FakeExchanger {
    fn new(revision: i64, expires_in: u64, token: &str) -> Self {
      Self {
        calls: AtomicUsize::new(0),
        revision: AtomicI64::new(revision),
        expires_in,
        token: Mutex::new(token.into()),
        fail: false,
      }
    }
  }

  impl GoogleTokenExchanger for FakeExchanger {
    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      cancel: Option<CancelToken>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      Box::pin(async move {
        if let Some(token) = cancel.as_ref() {
          if token.is_cancelled() {
            return Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "cancelled"));
          }
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
          return Err(CapabilityError::new(CapabilityErrorCode::Auth, "oauth failed"));
        }
        Ok(ExchangedToken {
          access_token: self.token.lock().unwrap().clone(),
          expires_in: self.expires_in,
          credential_revision: self.revision.load(Ordering::SeqCst),
        })
      })
    }
  }

  /// Blocks until released, then returns a token for the configured revision.
  struct BarrierExchanger {
    start: Arc<Notify>,
    release: Arc<Notify>,
    calls: AtomicUsize,
    revision: i64,
    token: String,
  }

  impl GoogleTokenExchanger for BarrierExchanger {
    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      cancel: Option<CancelToken>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      Box::pin(async move {
        self.start.notify_one();
        self.release.notified().await;
        if let Some(token) = cancel.as_ref() {
          if token.is_cancelled() {
            return Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "cancelled"));
          }
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ExchangedToken {
          access_token: self.token.clone(),
          expires_in: 3600,
          credential_revision: self.revision,
        })
      })
    }
  }

  fn grant_request(instance_id: Uuid, scopes: &[&str]) -> TokenGrantRequest {
    TokenGrantRequest {
      instance_id,
      capability_id: TRANSLATE_TEXT_CAPABILITY_ID.into(),
      auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
      scopes: scopes.iter().map(|s| (*s).to_string()).collect(),
      audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
    }
  }

  fn translation_scope() -> &'static str {
    GOOGLE_CLOUD_TRANSLATION_SCOPE
  }

  #[tokio::test]
  async fn token_grant_cache_hit_avoids_second_exchange() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-1"));
    let clock = Arc::new(FakeClock::new(1_700_000_000));
    let service = TokenGrantService::with_clock(exchanger.clone(), clock);
    let id = Uuid::nil();
    let g1 = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    let g2 = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 1);
    assert_eq!(g1.credential_revision(), g2.credential_revision());
  }

  #[tokio::test]
  async fn token_grant_expiry_triggers_refresh() {
    let exchanger = Arc::new(FakeExchanger::new(1, 70, "tok-1"));
    let clock = Arc::new(FakeClock::new(1_700_000_000));
    let service = TokenGrantService::with_clock(exchanger.clone(), clock.clone());
    let id = Uuid::nil();
    service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    // Safety skew is 60s; with expires_in=70 effective life is ~10s.
    clock.advance(Duration::from_secs(11));
    service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn token_grant_evict_instance_clears_cache() {
    let exchanger = Arc::new(FakeExchanger::new(2, 3600, "tok-1"));
    let service = TokenGrantService::new(exchanger.clone());
    let id = Uuid::nil();
    service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    service.evict_instance(id);
    service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn token_grant_revision_invalidation_requires_reexchange() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-rev1"));
    let service = TokenGrantService::new(exchanger.clone());
    let id = Uuid::nil();

    let first = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(first.credential_revision(), 1);
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 1);

    // Simulate credential replace: bump revision and evict cached grants.
    exchanger.revision.store(2, Ordering::SeqCst);
    *exchanger.token.lock().unwrap() = "tok-rev2".into();
    service.evict_instance(id);

    let second = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(second.credential_revision(), 2);
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 2);

    // Cache hit for the new revision.
    let third = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(third.credential_revision(), 2);
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn token_grant_concurrent_replace_does_not_reinsert_stale_revision() {
    let start = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let stale = Arc::new(BarrierExchanger {
      start: start.clone(),
      release: release.clone(),
      calls: AtomicUsize::new(0),
      revision: 1,
      token: "stale-tok".into(),
    });
    let service = TokenGrantService::new(stale.clone());
    let id = Uuid::nil();

    let acquire = tokio::spawn({
      let service = service.clone();
      async move { service.acquire(grant_request(id, &[translation_scope()]), None).await }
    });

    start.notified().await;
    // Credential replace while exchange is in flight.
    service.evict_instance(id);
    release.notify_one();

    let stale_grant = acquire.await.unwrap().unwrap();
    assert_eq!(stale_grant.credential_revision(), 1);
    assert_eq!(stale.calls.load(Ordering::SeqCst), 1);

    // Next acquire must not reuse the stale in-flight grant via cache.
    let fresh = Arc::new(FakeExchanger::new(2, 3600, "fresh-tok"));
    let service = TokenGrantService {
      cache: service.cache.clone(),
      clock: service.clock.clone(),
      exchanger: fresh.clone(),
    };
    let next = service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    assert_eq!(next.credential_revision(), 2);
    assert_eq!(fresh.calls.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn token_grant_scope_separation() {
    // Scope separation still requires allow-listed scopes only; use detect vs translate
    // capability paths with the same allowed scope string ordered differently.
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-1"));
    let service = TokenGrantService::new(exchanger.clone());
    let id = Uuid::nil();
    service
      .acquire(grant_request(id, &[translation_scope()]), None)
      .await
      .unwrap();
    // Same scope normalizes to one key — second call is a cache hit.
    let detect_grant = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: DETECT_LANGUAGE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![translation_scope().into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap();
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 1);
    assert_eq!(detect_grant.capability_id(), DETECT_LANGUAGE_CAPABILITY_ID);
    assert_eq!(detect_grant.auth_driver_id(), GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID);
    assert_eq!(detect_grant.audience_policy_id(), GOOGLE_OAUTH_AUDIENCE_POLICY_ID);
  }

  #[tokio::test]
  async fn token_grant_rejects_untrusted_driver_and_audience() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-1"));
    let service = TokenGrantService::new(exchanger);
    let mut req = grant_request(Uuid::nil(), &[translation_scope()]);
    req.auth_driver_id = "evil".into();
    let err = service.acquire(req, None).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);

    let mut req = grant_request(Uuid::nil(), &[translation_scope()]);
    req.audience_policy_id = "custom-url".into();
    let err = service.acquire(req, None).await.unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn token_grant_rejects_cloud_platform_and_unknown_scopes() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-1"));
    let service = TokenGrantService::new(exchanger.clone());
    let id = Uuid::nil();

    let err = service
      .acquire(
        grant_request(id, &["https://www.googleapis.com/auth/cloud-platform"]),
        None,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(exchanger.calls.load(Ordering::SeqCst), 0);

    let err = service
      .acquire(grant_request(id, &["https://example.com/evil"]), None)
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);

    let err = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: "vision.ocr@1".into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![translation_scope().into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[tokio::test]
  async fn token_grant_cancellation_short_circuits() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-1"));
    let service = TokenGrantService::new(exchanger);
    let cancel = CancelToken::new();
    cancel.cancel();
    let err = service
      .acquire(grant_request(Uuid::nil(), &[translation_scope()]), Some(&cancel))
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Cancelled);
  }

  #[test]
  fn token_grant_debug_redacts_access_token() {
    let grant = TokenGrant {
      access_token: "super-secret-token".into(),
      expires_at: Instant::now() + Duration::from_secs(60),
      instance_id: Uuid::nil(),
      credential_revision: 1,
      capability_id: "translate.text@1".into(),
      auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
      audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
      scope_key: "s".into(),
    };
    let rendered = format!("{grant:?}");
    assert!(!rendered.contains("super-secret-token"));
  }

  #[tokio::test]
  async fn token_grant_ocr_accepts_vision_scope_only() {
    let exchanger = Arc::new(FakeExchanger::new(1, 3600, "tok-vision"));
    let service = TokenGrantService::new(exchanger.clone());
    let id = Uuid::nil();

    let grant = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: OCR_IMAGE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_VISION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap();
    assert_eq!(grant.credential_revision(), 1);

    // Translate capability must not receive the vision scope.
    let err = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: TRANSLATE_TEXT_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_VISION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);

    // OCR capability must not receive the translation scope.
    let err = service
      .acquire(
        TokenGrantRequest {
          instance_id: id,
          capability_id: OCR_IMAGE_CAPABILITY_ID.into(),
          auth_driver_id: GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID.into(),
          scopes: vec![GOOGLE_CLOUD_TRANSLATION_SCOPE.into()],
          audience_policy_id: GOOGLE_OAUTH_AUDIENCE_POLICY_ID.into(),
        },
        None,
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::PermissionDenied);
  }

  #[test]
  fn normalize_scope_key_sorts_and_dedups() {
    let key = normalize_scope_key(&["b".into(), "a".into(), "b".into(), " a ".into()]);
    assert_eq!(key, "a b");
  }

  #[test]
  fn cache_key_includes_revision() {
    let id = Uuid::nil();
    let a = cache_key(id, 1, "scope");
    let b = cache_key(id, 2, "scope");
    assert_ne!(a, b);
    assert!(a.contains("|1|"));
    assert!(b.contains("|2|"));
  }
}
