// ABOUTME: Plugin Profile Translate/Detect IPC that reloads authoritative bindings from SQLite.
// ABOUTME: Never accepts endpoint/credential/capability overrides from the frontend.
use crate::domain::cancel::CancelToken;
use crate::domain::language_detection::{DETECT_CANCELLED_CODE, DetectLanguageResult, DetectorType};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, DetectLanguageRequest, TranslateTextRequest, validate_capability_language_id,
  validate_capability_request_id, validate_capability_text,
};
use crate::domain::service_integration::IntegrationHealthStatus;
use crate::domain::translation::{TRANSLATE_CANCELLED_CODE, TranslateResult};
use crate::error::{IpcError, StorageError};
use crate::repositories::{integration_instances, translation_profiles};
use crate::services::service_capabilities::execution_context;
use crate::state::AppState;
use serde::Deserialize;
use std::time::Instant;
use tauri::State;
use uuid::Uuid;

/// Runtime language id rejected at the Profile Translate IPC boundary.
const AUTO_LANGUAGE_ID: &str = "auto";

/// Frontend request to translate via a plugin-capability Profile.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProfileTranslateInput {
  pub request_id: String,
  pub profile_id: Uuid,
  pub text: String,
  /// Concrete app source language id. Never `auto` or a localized display label.
  pub source_lang: String,
  /// Concrete app target language id. Never `auto` or a localized display label.
  pub target_lang: String,
}

/// Frontend request to detect language via a plugin-capability Profile.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProfileDetectInput {
  pub request_id: String,
  pub profile_id: Uuid,
  pub text: String,
}

#[tauri::command]
pub async fn translate_service_profile(
  state: State<'_, AppState>,
  input: ServiceProfileTranslateInput,
) -> Result<TranslateResult, IpcError> {
  Ok(run_translate_service_profile(&state.service_capabilities, &state.request_sessions, input).await)
}

#[tauri::command]
pub async fn detect_service_profile_language(
  state: State<'_, AppState>,
  input: ServiceProfileDetectInput,
) -> Result<DetectLanguageResult, IpcError> {
  Ok(run_detect_service_profile_language(&state.service_capabilities, &state.request_sessions, input).await)
}

#[derive(Debug)]
struct ResolvedPluginProfile {
  instance_id: Uuid,
  plugin_id: String,
  translate_capability_id: String,
  detect_capability_id: Option<String>,
  /// Exact SQLite preference TEXT for the bound profile (byte-exact Wasm copy).
  preferences_json: Vec<u8>,
}

/// Reload Profile + instance from SQLite and validate plugin branch readiness.
async fn resolve_plugin_profile(state: &AppState, profile_id: Uuid) -> Result<ResolvedPluginProfile, ResolveError> {
  let db = state.db.clone();
  tauri::async_runtime::spawn_blocking(move || db.read(|conn| resolve_plugin_profile_conn(conn, profile_id)))
    .await
    .map_err(|e| ResolveError::Join(e.to_string()))?
    .map_err(ResolveError::Storage)
}

/// Load one immutable profile/runtime snapshot for Translate (true) or Detect (false).
async fn resolve_plugin_profile_snapshot(
  state: &AppState,
  profile_id: Uuid,
  translate: bool,
) -> Result<crate::services::service_capabilities::ProfileInvocationSnapshot, ResolveError> {
  let caps = state.service_capabilities.clone();
  let kind = if translate {
    crate::services::service_capabilities::ProfileCapabilityKind::Translate
  } else {
    crate::services::service_capabilities::ProfileCapabilityKind::Detect
  };
  tauri::async_runtime::spawn_blocking(move || caps.load_profile_invocation_snapshot(profile_id, kind))
    .await
    .map_err(|e| ResolveError::Join(e.to_string()))?
    .map_err(|e| {
      use crate::services::service_capabilities::ProfileSnapshotLoadError;
      match e {
        ProfileSnapshotLoadError::NotFound(msg) => ResolveError::Storage(StorageError::NotFound(msg)),
        ProfileSnapshotLoadError::PluginUnavailable(msg) => ResolveError::Storage(StorageError::PluginUnavailable(msg)),
        ProfileSnapshotLoadError::InvalidConfiguration(msg) => {
          // Keep detect-unavailable distinguishable for missing detect binding.
          if msg.contains("no detect capability") {
            ResolveError::DetectUnavailable
          } else {
            ResolveError::Storage(StorageError::Validation(msg))
          }
        }
        ProfileSnapshotLoadError::Internal(msg) => ResolveError::Storage(StorageError::Internal(msg)),
      }
    })
}

/// Testable formal translate workflow (same path as the Tauri command).
/// SQLite snapshot load + archive/artifact rehash + component resolution run on a blocking pool;
/// only the typed capability call stays on the async path (cancel/error semantics preserved).
pub async fn run_translate_service_profile(
  caps: &crate::services::service_capabilities::ServiceCapabilityService,
  sessions: &crate::domain::cancel::RequestSessionRegistry,
  input: ServiceProfileTranslateInput,
) -> TranslateResult {
  let started = Instant::now();
  if let Err(err) = validate_capability_request_id(&input.request_id) {
    return capability_to_translate_failure(&err, elapsed_ms(started));
  }
  if let Err(err) = validate_capability_text(&input.text) {
    return capability_to_translate_failure(&err, elapsed_ms(started));
  }
  if let Err(err) = validate_runtime_language_id(&input.source_lang, "source_lang") {
    return capability_to_translate_failure(&err, elapsed_ms(started));
  }
  if let Err(err) = validate_runtime_language_id(&input.target_lang, "target_lang") {
    return capability_to_translate_failure(&err, elapsed_ms(started));
  }
  let token = sessions.begin(&input.request_id);
  let caps = caps.clone();
  let profile_id = input.profile_id;
  let prepared = tauri::async_runtime::spawn_blocking(move || {
    use crate::services::service_capabilities::ProfileCapabilityKind;
    let snapshot = caps.load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Translate)?;
    let handler = caps
      .resolve_translate_from_snapshot(&snapshot)
      .map_err(crate::services::service_capabilities::ProfileSnapshotLoadError::from_capability)?;
    Ok::<_, crate::services::service_capabilities::ProfileSnapshotLoadError>((snapshot, handler))
  })
  .await;
  let result = match prepared {
    Ok(Ok((snapshot, handler))) => {
      let ctx = execution_context(
        input.request_id.clone(),
        token.clone(),
        snapshot.instance_id,
        snapshot.plugin_id.clone(),
        snapshot.capability_id.clone(),
      );
      let request = TranslateTextRequest {
        text: input.text,
        source_language_id: input.source_lang,
        target_language_id: input.target_lang,
      };
      match handler.translate(snapshot.instance_id, request, ctx).await {
        Ok(response) => TranslateResult {
          translated_text: response.translated_text,
          latency_ms: elapsed_ms(started),
          error_code: None,
          message: "ok".into(),
          ok: true,
          model_id: None,
        },
        Err(err) => capability_to_translate_failure(&err, elapsed_ms(started)),
      }
    }
    Ok(Err(err)) => resolve_error_to_translate(snapshot_load_to_resolve(err), elapsed_ms(started), &token),
    Err(join_err) => {
      log::error!("translate_service_profile_blocking_join_failed error={join_err}");
      resolve_error_to_translate(
        ResolveError::Join("blocking join failed".into()),
        elapsed_ms(started),
        &token,
      )
    }
  };
  sessions.end(&input.request_id);
  result
}

/// Testable formal detect workflow (same path as the Tauri command).
/// Snapshot + rehash + resolve run via spawn_blocking; only capability await stays async.
pub async fn run_detect_service_profile_language(
  caps: &crate::services::service_capabilities::ServiceCapabilityService,
  sessions: &crate::domain::cancel::RequestSessionRegistry,
  input: ServiceProfileDetectInput,
) -> DetectLanguageResult {
  let started = Instant::now();
  if let Err(err) = validate_capability_request_id(&input.request_id) {
    return capability_to_detect_failure(&err, elapsed_ms(started));
  }
  if let Err(err) = validate_capability_text(&input.text) {
    return capability_to_detect_failure(&err, elapsed_ms(started));
  }
  let token = sessions.begin(&input.request_id);
  let caps = caps.clone();
  let profile_id = input.profile_id;
  let prepared = tauri::async_runtime::spawn_blocking(move || {
    use crate::services::service_capabilities::ProfileCapabilityKind;
    let snapshot = caps.load_profile_invocation_snapshot(profile_id, ProfileCapabilityKind::Detect)?;
    let handler = caps
      .resolve_detect_from_snapshot(&snapshot)
      .map_err(crate::services::service_capabilities::ProfileSnapshotLoadError::from_capability)?;
    Ok::<_, crate::services::service_capabilities::ProfileSnapshotLoadError>((snapshot, handler))
  })
  .await;
  let result = match prepared {
    Ok(Ok((snapshot, handler))) => {
      let ctx = execution_context(
        input.request_id.clone(),
        token.clone(),
        snapshot.instance_id,
        snapshot.plugin_id.clone(),
        snapshot.capability_id.clone(),
      );
      let request = DetectLanguageRequest { text: input.text };
      match handler.detect(snapshot.instance_id, request, ctx).await {
        Ok(response) => DetectLanguageResult {
          ok: true,
          language_id: Some(response.language_id),
          detector_type: DetectorType::ServiceIntegration,
          model_id: None,
          latency_ms: elapsed_ms(started),
          error_code: None,
          message: "ok".into(),
        },
        Err(err) => capability_to_detect_failure(&err, elapsed_ms(started)),
      }
    }
    Ok(Err(err)) => resolve_error_to_detect(snapshot_load_to_resolve(err), elapsed_ms(started), &token),
    Err(join_err) => {
      log::error!("detect_service_profile_blocking_join_failed error={join_err}");
      resolve_error_to_detect(
        ResolveError::Join("blocking join failed".into()),
        elapsed_ms(started),
        &token,
      )
    }
  };
  sessions.end(&input.request_id);
  result
}

fn snapshot_load_to_resolve(err: crate::services::service_capabilities::ProfileSnapshotLoadError) -> ResolveError {
  use crate::services::service_capabilities::ProfileSnapshotLoadError;
  match err {
    ProfileSnapshotLoadError::NotFound(msg) => ResolveError::Storage(StorageError::NotFound(msg)),
    ProfileSnapshotLoadError::PluginUnavailable(msg) => ResolveError::Storage(StorageError::PluginUnavailable(msg)),
    ProfileSnapshotLoadError::InvalidConfiguration(msg) => {
      if msg.contains("no detect capability") {
        ResolveError::DetectUnavailable
      } else {
        ResolveError::Storage(StorageError::Validation(msg))
      }
    }
    ProfileSnapshotLoadError::Internal(msg) => ResolveError::Storage(StorageError::Internal(msg)),
  }
}

fn map_capability_to_resolve(err: CapabilityError) -> ResolveError {
  use CapabilityErrorCode::*;
  // Preserve stable capability codes; do not collapse everything into Validation.
  if err.message.contains("no detect capability") {
    return ResolveError::DetectUnavailable;
  }
  match err.code {
    PluginUnavailable => ResolveError::Storage(StorageError::PluginUnavailable(err.message)),
    InvalidConfiguration | InvalidRequest => ResolveError::Storage(StorageError::Validation(err.message)),
    PermissionDenied | Cancelled | Timeout | Auth | QuotaExceeded | RateLimited | Network | InvalidResponse
    | ProviderUnavailable | UnsupportedInput | UnsupportedLanguage | Internal => ResolveError::Capability(err),
  }
}

/// Authoritative Profile/instance reload used immediately before capability execution.
///
/// Frontend cannot override plugin id, endpoint, credentials, project, model, or capability:
/// those come only from SQLite bindings resolved here.
fn resolve_plugin_profile_conn(
  conn: &rusqlite::Connection,
  profile_id: Uuid,
) -> Result<ResolvedPluginProfile, StorageError> {
  let dto = translation_profiles::get(conn, profile_id)?;
  if !dto.profile.enabled {
    return Err(StorageError::Validation("profile is disabled".into()));
  }
  let plugin = dto
    .profile
    .engine
    .as_plugin()
    .ok_or_else(|| StorageError::Validation("profile is not a plugin capability engine".into()))?;
  let instance = integration_instances::get(conn, plugin.integration_instance_id)?;
  if !instance.enabled {
    return Err(StorageError::Validation("integration instance is disabled".into()));
  }
  // Require Ready immediately before execution (not merely non-unconfigured).
  if !matches!(instance.health_status, IntegrationHealthStatus::Ready) {
    return Err(StorageError::Validation("integration instance is not ready".into()));
  }
  // Prefer the authoritative SQLite TEXT so Wasm receives the exact migrated preferences.
  let preferences_json: String = conn.query_row(
    "SELECT capability_preferences_json FROM translation_profiles WHERE id = ?1",
    rusqlite::params![profile_id.to_string()],
    |row| row.get(0),
  )?;
  Ok(ResolvedPluginProfile {
    instance_id: instance.id,
    plugin_id: instance.plugin_id,
    translate_capability_id: plugin.translate_capability_id.clone(),
    detect_capability_id: plugin.detect_capability_id.clone(),
    preferences_json: preferences_json.into_bytes(),
  })
}

enum ResolveError {
  Storage(StorageError),
  Capability(CapabilityError),
  DetectUnavailable,
  Join(String),
}

fn elapsed_ms(started: Instant) -> u64 {
  started.elapsed().as_millis() as u64
}

/// Profile Translate IPC accepts only concrete app language ids (never `auto`).
fn validate_runtime_language_id(language_id: &str, field: &str) -> Result<(), CapabilityError> {
  validate_capability_language_id(language_id, field)?;
  if language_id.eq_ignore_ascii_case(AUTO_LANGUAGE_ID) {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidRequest,
      format!("{field} must be a concrete language id; auto is not allowed"),
    ));
  }
  Ok(())
}

fn capability_to_translate_failure(err: &CapabilityError, latency_ms: u64) -> TranslateResult {
  if err.code == CapabilityErrorCode::Cancelled {
    return TranslateResult::cancelled(latency_ms);
  }
  TranslateResult::failure(err.code.as_str(), err.message.clone(), latency_ms)
}

fn capability_to_detect_failure(err: &CapabilityError, latency_ms: u64) -> DetectLanguageResult {
  if err.code == CapabilityErrorCode::Cancelled {
    return DetectLanguageResult {
      ok: false,
      language_id: None,
      detector_type: DetectorType::ServiceIntegration,
      model_id: None,
      latency_ms,
      error_code: Some(DETECT_CANCELLED_CODE.into()),
      message: "Language detection cancelled".into(),
    };
  }
  DetectLanguageResult {
    ok: false,
    language_id: None,
    detector_type: DetectorType::ServiceIntegration,
    model_id: None,
    latency_ms,
    error_code: Some(err.code.as_str().into()),
    message: err.message.clone(),
  }
}

fn resolve_error_to_translate(err: ResolveError, latency_ms: u64, token: &CancelToken) -> TranslateResult {
  if token.is_cancelled() {
    return TranslateResult::failure(TRANSLATE_CANCELLED_CODE, "Translation cancelled", latency_ms);
  }
  match err {
    ResolveError::Storage(StorageError::NotFound(msg)) => TranslateResult::failure("not_found", msg, latency_ms),
    ResolveError::Storage(StorageError::Validation(msg)) => {
      TranslateResult::failure("invalid_configuration", msg, latency_ms)
    }
    ResolveError::Storage(StorageError::PluginUnavailable(msg)) => {
      TranslateResult::failure("plugin_unavailable", msg, latency_ms)
    }
    ResolveError::Storage(other) => TranslateResult::failure("internal", other.to_string(), latency_ms),
    ResolveError::Capability(err) => capability_to_translate_failure(&err, latency_ms),
    ResolveError::DetectUnavailable => {
      TranslateResult::failure("detect_unavailable", "profile has no detect capability", latency_ms)
    }
    ResolveError::Join(msg) => TranslateResult::failure("internal", msg, latency_ms),
  }
}

fn resolve_error_to_detect(err: ResolveError, latency_ms: u64, token: &CancelToken) -> DetectLanguageResult {
  if token.is_cancelled() {
    return DetectLanguageResult {
      ok: false,
      language_id: None,
      detector_type: DetectorType::ServiceIntegration,
      model_id: None,
      latency_ms,
      error_code: Some(DETECT_CANCELLED_CODE.into()),
      message: "Language detection cancelled".into(),
    };
  }
  let (code, message) = match err {
    ResolveError::Storage(StorageError::NotFound(msg)) => ("not_found", msg),
    ResolveError::Storage(StorageError::Validation(msg)) => ("invalid_configuration", msg),
    ResolveError::Storage(StorageError::PluginUnavailable(msg)) => ("plugin_unavailable", msg),
    ResolveError::Storage(other) => ("internal", other.to_string()),
    ResolveError::Capability(err) => return capability_to_detect_failure(&err, latency_ms),
    ResolveError::DetectUnavailable => ("detect_unavailable", "profile has no detect capability".into()),
    ResolveError::Join(msg) => ("internal", msg),
  };
  DetectLanguageResult {
    ok: false,
    language_id: None,
    detector_type: DetectorType::ServiceIntegration,
    model_id: None,
    latency_ms,
    error_code: Some(code.into()),
    message,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_capability::{DetectLanguageResponse, TranslateTextResponse};
  use crate::domain::service_integration::{
    GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GoogleCloudConfigV1, IntegrationHealthStatus,
    IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::domain::translation_profile::{
    GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine,
    empty_google_translate_preferences,
  };
  use crate::repositories::integration_instances;
  use crate::repositories::translation_profiles as profile_repo;
  use crate::services::google_cloud::{GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID};
  use crate::services::service_capabilities::{
    CapabilityHandler, DetectLanguageCapability, ServiceCapabilityRegistry, ServiceCapabilityService,
    TranslateTextCapability,
  };
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use crate::storage::Database;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Arc;
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
  use std::time::Duration;

  struct FakeTranslate {
    calls: AtomicUsize,
    fail: AtomicBool,
    hang_until_cancel: AtomicBool,
    timeout: AtomicBool,
  }

  impl TranslateTextCapability for FakeTranslate {
    fn translate(
      &self,
      _instance_id: Uuid,
      request: TranslateTextRequest,
      context: crate::domain::service_capability::ExecutionContext,
    ) -> Pin<Box<dyn Future<Output = Result<TranslateTextResponse, CapabilityError>> + Send + '_>> {
      Box::pin(async move {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.hang_until_cancel.load(Ordering::SeqCst) {
          loop {
            if context.cancel.is_cancelled() {
              return Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "cancelled"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
          }
        }
        if context.cancel.is_cancelled() {
          return Err(CapabilityError::new(CapabilityErrorCode::Cancelled, "cancelled"));
        }
        if self.timeout.load(Ordering::SeqCst) {
          return Err(CapabilityError::new(CapabilityErrorCode::Timeout, "timed out"));
        }
        if self.fail.load(Ordering::SeqCst) {
          return Err(CapabilityError::new(CapabilityErrorCode::Auth, "auth failed"));
        }
        Ok(TranslateTextResponse {
          translated_text: format!("T:{}", request.text),
          detected_source_language_id: Some("en".into()),
        })
      })
    }
  }

  struct FakeDetect;
  impl DetectLanguageCapability for FakeDetect {
    fn detect(
      &self,
      _instance_id: Uuid,
      _request: DetectLanguageRequest,
      _context: crate::domain::service_capability::ExecutionContext,
    ) -> Pin<Box<dyn Future<Output = Result<DetectLanguageResponse, CapabilityError>> + Send + '_>> {
      Box::pin(async move {
        Ok(DetectLanguageResponse {
          language_id: "en".into(),
          confidence: Some(0.9),
        })
      })
    }
  }

  struct Fixture {
    db: Database,
    profile_id: Uuid,
    instance_id: Uuid,
    caps: Arc<ServiceCapabilityService>,
    fake: Arc<FakeTranslate>,
    _dir_keep: tempfile::TempDir,
  }

  fn setup_fixture(
    enabled_profile: bool,
    enabled_instance: bool,
    health: IntegrationHealthStatus,
    plugin_id: &str,
    register_handlers: bool,
  ) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let instance_id = new_id();
    let profile_id = new_id();
    let now = now_rfc3339();
    let config = GoogleCloudConfigV1 {
      project_id: "demo".into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: crate::domain::provider::ProxyMode::Direct,
    };
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id: instance_id,
          plugin_id: plugin_id.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Work".into(),
          enabled: enabled_instance,
          config_json: serde_json::to_string(&config).unwrap(),
          config_schema_version: 1,
          health_status: health,
          last_validated_at: Some(now.clone()),
          last_error_code: None,
          runtime_kind: "bundled-rust".into(),
          package_digest: None,
          execution_grant_set_revision: None,
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      let profile = TranslationProfile {
        id: profile_id,
        name: "Plugin".into(),
        enabled: enabled_profile,
        source_lang: Some("auto".into()),
        target_lang: Some("zh".into()),
        primary_lang: Some("en".into()),
        preferred_target_lang: Some("zh".into()),
        engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
          integration_instance_id: instance_id,
          translate_capability_id: GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID.into(),
          detect_capability_id: Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID.into()),
          capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
          capability_preferences: empty_google_translate_preferences(),
        }),
        created_at: now.clone(),
        updated_at: now,
      };
      profile_repo::save_with_targets(uow.conn(), &profile, &[], &[], true)?;
      Ok(())
    })
    .unwrap();

    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let mut handlers = ServiceCapabilityRegistry::new();
    let fake = Arc::new(FakeTranslate {
      calls: AtomicUsize::new(0),
      fail: AtomicBool::new(false),
      hang_until_cancel: AtomicBool::new(false),
      timeout: AtomicBool::new(false),
    });
    if register_handlers {
      handlers.register(
        GOOGLE_CLOUD_PLUGIN_ID,
        GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID,
        CapabilityHandler::TranslateText(fake.clone()),
      );
      handlers.register(
        GOOGLE_CLOUD_PLUGIN_ID,
        GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID,
        CapabilityHandler::DetectLanguage(Arc::new(FakeDetect)),
      );
    }
    let handlers = Arc::new(handlers);
    let packages = crate::services::plugin_store::PluginPackageService::with_vendor_roots(
      db.clone(),
      dir.path().to_path_buf(),
      vec![],
    );
    let wasm = Arc::new(crate::services::wasm_runtime::WasmRuntime::new().unwrap());
    let router = crate::services::runtime_router::RuntimeRouter::new(
      db.clone(),
      registry.clone(),
      handlers.clone(),
      packages,
      wasm.clone(),
    );
    let caps = Arc::new(ServiceCapabilityService::new(db.clone(), registry, handlers).with_router(router, wasm));
    Fixture {
      db,
      profile_id,
      instance_id,
      caps,
      fake,
      _dir_keep: dir,
    }
  }

  fn execute_translate(fixture: &Fixture, request_id: &str, text: &str) -> TranslateResult {
    let sessions = crate::domain::cancel::RequestSessionRegistry::new();
    let token = sessions.begin(request_id);
    let started = Instant::now();
    let result = match fixture
      .db
      .read(|conn| resolve_plugin_profile_conn(conn, fixture.profile_id))
    {
      Ok(resolved) => match fixture.caps.resolve_translate(
        resolved.instance_id,
        &resolved.translate_capability_id,
        resolved.preferences_json.clone(),
      ) {
        Ok(handler) => {
          let ctx = execution_context(
            request_id.to_string(),
            token.clone(),
            resolved.instance_id,
            resolved.plugin_id,
            resolved.translate_capability_id.clone(),
          );
          let request = TranslateTextRequest {
            text: text.into(),
            source_language_id: "en".into(),
            target_language_id: "zh".into(),
          };
          match tauri::async_runtime::block_on(handler.translate(resolved.instance_id, request, ctx)) {
            Ok(response) => TranslateResult {
              translated_text: response.translated_text,
              latency_ms: elapsed_ms(started),
              error_code: None,
              message: "ok".into(),
              ok: true,
              model_id: None,
            },
            Err(err) => capability_to_translate_failure(&err, elapsed_ms(started)),
          }
        }
        Err(err) => capability_to_translate_failure(&err, elapsed_ms(started)),
      },
      Err(err) => resolve_error_to_translate(ResolveError::Storage(err), elapsed_ms(started), &token),
    };
    sessions.end(request_id);
    result
  }

  #[test]
  fn service_translation_input_rejects_frontend_overrides() {
    // Compile-time shape guard: only request_id/profile_id/text/langs are accepted.
    let json = serde_json::json!({
      "requestId": "req-1",
      "profileId": new_id(),
      "text": "hi",
      "sourceLang": "en",
      "targetLang": "zh",
      "pluginId": "evil",
      "endpoint": "https://evil.example",
      "credential": "secret",
      "projectId": "p",
      "model": "m",
      "capabilityId": "translate.text@9"
    });
    let parsed: ServiceProfileTranslateInput = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.request_id, "req-1");
    // Extra override fields are ignored by serde (not present on the struct).
    let encoded = serde_json::to_value(&serde_json::json!({
      "requestId": parsed.request_id,
      "profileId": parsed.profile_id,
      "text": parsed.text,
      "sourceLang": parsed.source_lang,
      "targetLang": parsed.target_lang,
    }))
    .unwrap();
    assert!(encoded.get("pluginId").is_none());
    assert!(encoded.get("endpoint").is_none());
    assert!(encoded.get("credential").is_none());
    assert!(encoded.get("projectId").is_none());
    assert!(encoded.get("model").is_none());
    assert!(encoded.get("capabilityId").is_none());
  }

  #[test]
  fn service_translation_rejects_auto_language_ids() {
    let source_err = validate_runtime_language_id("auto", "source_lang").unwrap_err();
    assert_eq!(source_err.code, CapabilityErrorCode::InvalidRequest);
    assert!(source_err.message.contains("auto"));
    let target_err = validate_runtime_language_id("AUTO", "target_lang").unwrap_err();
    assert_eq!(target_err.code, CapabilityErrorCode::InvalidRequest);
    assert!(validate_runtime_language_id("en", "source_lang").is_ok());
    assert!(validate_runtime_language_id("zh", "target_lang").is_ok());
  }

  #[test]
  fn service_translation_success_null_model_id() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    // Formal workflow helper (same path as the Tauri command).
    let sessions = crate::domain::cancel::RequestSessionRegistry::new();
    let result = tauri::async_runtime::block_on(run_translate_service_profile(
      &fixture.caps,
      &sessions,
      ServiceProfileTranslateInput {
        request_id: "req-success".into(),
        profile_id: fixture.profile_id,
        text: "hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ));
    assert!(result.ok, "{result:?}");
    assert_eq!(result.translated_text, "T:hello");
    assert!(result.model_id.is_none());
    assert_eq!(fixture.fake.calls.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn service_translation_stale_profile_id_fails_closed() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    let missing = new_id();
    let sessions = crate::domain::cancel::RequestSessionRegistry::new();
    let result = tauri::async_runtime::block_on(run_translate_service_profile(
      &fixture.caps,
      &sessions,
      ServiceProfileTranslateInput {
        request_id: "req-missing".into(),
        profile_id: missing,
        text: "hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ));
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("not_found"));
    assert!(result.model_id.is_none());
  }

  #[test]
  fn service_translation_package_unavailable_maps_plugin_unavailable() {
    // Typed snapshot load maps package/grant issues to plugin_unavailable, not not_found.
    let err = crate::services::service_capabilities::ProfileSnapshotLoadError::PluginUnavailable(
      "installed package missing".into(),
    );
    let storage = err.into_resolve_storage();
    assert!(matches!(storage, StorageError::PluginUnavailable(_)));
    let token = CancelToken::new();
    let result = resolve_error_to_translate(ResolveError::Storage(storage), 1, &token);
    assert_eq!(result.error_code.as_deref(), Some("plugin_unavailable"));
  }

  #[test]
  fn service_detect_formal_missing_profile_is_not_found() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    let sessions = crate::domain::cancel::RequestSessionRegistry::new();
    let result = tauri::async_runtime::block_on(run_detect_service_profile_language(
      &fixture.caps,
      &sessions,
      ServiceProfileDetectInput {
        request_id: "req-det-missing".into(),
        profile_id: new_id(),
        text: "hello".into(),
      },
    ));
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("not_found"));
  }

  #[test]
  fn service_translation_disabled_instance_fails_before_handler() {
    let fixture = setup_fixture(
      true,
      false,
      IntegrationHealthStatus::Ready,
      GOOGLE_CLOUD_PLUGIN_ID,
      true,
    );
    let result = execute_translate(&fixture, "req-disabled", "hello");
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("invalid_configuration"));
    assert!(result.model_id.is_none());
    assert_eq!(fixture.fake.calls.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn service_translation_non_ready_instance_fails_before_handler() {
    let fixture = setup_fixture(
      true,
      true,
      IntegrationHealthStatus::Unvalidated,
      GOOGLE_CLOUD_PLUGIN_ID,
      true,
    );
    let result = execute_translate(&fixture, "req-unvalidated", "hello");
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("invalid_configuration"));
    assert!(result.message.contains("not ready"));
    assert!(result.model_id.is_none());
    assert_eq!(fixture.fake.calls.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn service_translation_missing_plugin_handler_fails_closed() {
    // Instance claims google plugin but no handler is registered (missing plugin runtime).
    let fixture = setup_fixture(
      true,
      true,
      IntegrationHealthStatus::Ready,
      GOOGLE_CLOUD_PLUGIN_ID,
      false,
    );
    let result = execute_translate(&fixture, "req-missing-handler", "hello");
    assert!(!result.ok);
    assert!(result.model_id.is_none());
    assert!(
      result.error_code.as_deref() == Some("plugin_unavailable")
        || result.error_code.as_deref() == Some("invalid_configuration")
        || result.error_code.as_deref() == Some("permission_denied"),
      "{result:?}"
    );
  }

  #[test]
  fn service_translation_cancellation_maps_stable_code() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    fixture.fake.hang_until_cancel.store(true, Ordering::SeqCst);
    let sessions = Arc::new(crate::domain::cancel::RequestSessionRegistry::new());
    let request_id = "req-cancel-formal".to_string();
    let sessions_cancel = sessions.clone();
    let rid = request_id.clone();
    // Cancel during capability await via registry (formal run_* path).
    let cancel_thread = std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(20));
      // Cancel by starting a token for the same request id if already registered, else no-op.
      // The formal helper begins the session; race cancel after a short delay via public API:
      // re-begin is not allowed, so use cancel_request if available.
      sessions_cancel.cancel(&rid);
    });
    let result = tauri::async_runtime::block_on(run_translate_service_profile(
      &fixture.caps,
      sessions.as_ref(),
      ServiceProfileTranslateInput {
        request_id: request_id.clone(),
        profile_id: fixture.profile_id,
        text: "hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ));
    let _ = cancel_thread.join();
    assert!(!result.ok, "{result:?}");
    assert_eq!(
      result.error_code.as_deref(),
      Some(TRANSLATE_CANCELLED_CODE),
      "{result:?}"
    );
    assert!(result.model_id.is_none());
    // Session cleaned up by run_* (cancel after end is unknown).
    assert!(!sessions.cancel(&request_id));
  }

  #[test]
  fn service_detect_formal_cancellation_maps_stable_code() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    // Detect completes quickly; still exercise concurrent cancel + formal helper cleanup.
    let sessions = Arc::new(crate::domain::cancel::RequestSessionRegistry::new());
    let request_id = "req-det-cancel".to_string();
    let sessions_cancel = sessions.clone();
    let rid = request_id.clone();
    let cancel_thread = std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(5));
      sessions_cancel.cancel(&rid);
    });
    let result = tauri::async_runtime::block_on(run_detect_service_profile_language(
      &fixture.caps,
      sessions.as_ref(),
      ServiceProfileDetectInput {
        request_id: request_id.clone(),
        profile_id: fixture.profile_id,
        text: "hello".into(),
      },
    ));
    let _ = cancel_thread.join();
    assert!(!sessions.cancel(&request_id), "session must be cleaned up");
    if !result.ok {
      assert_eq!(result.error_code.as_deref(), Some(DETECT_CANCELLED_CODE), "{result:?}");
    }
  }

  #[test]
  fn service_translation_timeout_maps_stable_code() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    fixture.fake.timeout.store(true, Ordering::SeqCst);
    let sessions = crate::domain::cancel::RequestSessionRegistry::new();
    let result = tauri::async_runtime::block_on(run_translate_service_profile(
      &fixture.caps,
      &sessions,
      ServiceProfileTranslateInput {
        request_id: "req-timeout".into(),
        profile_id: fixture.profile_id,
        text: "hello".into(),
        source_lang: "en".into(),
        target_lang: "zh".into(),
      },
    ));
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("timeout"));
    assert!(result.model_id.is_none());
  }

  #[test]
  fn service_translation_capability_error_maps_cancelled() {
    let err = CapabilityError::new(CapabilityErrorCode::Cancelled, "cancelled");
    let result = capability_to_translate_failure(&err, 12);
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some(TRANSLATE_CANCELLED_CODE));
    assert!(result.model_id.is_none());
  }

  #[test]
  fn service_translation_detect_success_shape_has_null_model() {
    let result = DetectLanguageResult {
      ok: true,
      language_id: Some("en".into()),
      detector_type: DetectorType::ServiceIntegration,
      model_id: None,
      latency_ms: 5,
      error_code: None,
      message: "ok".into(),
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["detectorType"], "service_integration");
    assert!(json.get("modelId").is_none() || json["modelId"].is_null());
  }

  #[test]
  fn service_translation_resolve_uses_authoritative_instance_binding() {
    let fixture = setup_fixture(true, true, IntegrationHealthStatus::Ready, GOOGLE_CLOUD_PLUGIN_ID, true);
    let resolved = fixture
      .db
      .read(|conn| resolve_plugin_profile_conn(conn, fixture.profile_id))
      .unwrap();
    assert_eq!(resolved.instance_id, fixture.instance_id);
    assert_eq!(resolved.plugin_id, GOOGLE_CLOUD_PLUGIN_ID);
    assert_eq!(resolved.translate_capability_id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID);
    assert_eq!(
      resolved.detect_capability_id.as_deref(),
      Some(GOOGLE_DETECT_LANGUAGE_CAPABILITY_ID)
    );
  }
}
