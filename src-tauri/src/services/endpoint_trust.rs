// ABOUTME: Host-owned endpoint preview sessions, approval consumption, and status derivation.
// ABOUTME: Preview data is short-lived metadata; exact approvals are persisted only during save.
use crate::domain::endpoint_trust::{
  EDGE_TTS_TRUST_ENDPOINT_ALIAS, ENDPOINT_TRUST_METHOD, ENDPOINT_TRUST_PREVIEW_ID_MAX_LEN,
  ENDPOINT_TRUST_PREVIEW_TTL_SECS, ENDPOINT_TRUST_RELATIVE_PATH, EndpointEgressPolicy, EndpointTrustPreviewDto,
  EndpointTrustPreviewInput, EndpointTrustStatus, IntegrationEndpointTrust, RuntimeIdentityFingerprintInput,
  classify_endpoint_egress, configuration_fingerprint, runtime_identity_fingerprint,
};
use crate::domain::service_integration::{EDGE_TTS_DEFAULT_BASE_URL, EDGE_TTS_PLUGIN_ID, IntegrationInstance};
use crate::domain::time::{format_rfc3339, new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{integration_endpoint_trusts, integration_instances};
use crate::services::edge_tts::normalize_edge_tts_base_url;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use time::{Duration as TimeDuration, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct EndpointTrustPreviewSession {
  preview_id: String,
  instance_id: Option<Uuid>,
  /// Host-owned id reserved for a create preview; it is never supplied by the caller.
  creation_instance_id: Option<Uuid>,
  /// A validated preview is reserved while its save transaction is in flight.
  reserved: bool,
  plugin_id: String,
  plugin_version: String,
  endpoint_alias: String,
  normalized_origin: String,
  configuration_fingerprint: String,
  runtime_identity_fingerprint: String,
  expected_updated_at: Option<String>,
  expires_at: Instant,
}

#[derive(Debug, Clone)]
struct EdgeEndpointCandidate {
  normalized_base_url: String,
  configuration_fingerprint: String,
}

/// Endpoint trust service shared by preview IPC, integration save, and runtime policy checks.
#[derive(Clone)]
pub struct EndpointTrustService {
  db: Database,
  registry: Arc<ServiceIntegrationRegistry>,
  previews: Arc<Mutex<HashMap<String, EndpointTrustPreviewSession>>>,
}

impl EndpointTrustService {
  pub fn new(db: Database, registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self {
      db,
      registry,
      previews: Arc::new(Mutex::new(HashMap::new())),
    }
  }

  /// Create an expiring host preview without mutating configuration or approval rows.
  pub fn preview(&self, input: EndpointTrustPreviewInput) -> Result<EndpointTrustPreviewDto, StorageError> {
    self.expire_previews();
    let plugin_id = input.plugin_id.trim().to_string();
    if plugin_id != EDGE_TTS_PLUGIN_ID {
      return Err(StorageError::Validation(
        "endpoint review is only supported for Edge TTS".into(),
      ));
    }
    let registration = self
      .registry
      .get_registration(&plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(plugin_id.clone()))?;
    let normalized_config = registration.config_adapter.normalize_config(&input.config_json)?;
    let candidate = self.edge_candidate(&normalized_config)?;

    let (instance_id, creation_instance_id, plugin_version, runtime_kind, package_digest, expected_updated_at) =
      if let Some(instance_id) = input.instance_id {
        let instance = self.db.read(|conn| integration_instances::get(conn, instance_id))?;
        let expected = input
          .expected_updated_at
          .as_deref()
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .ok_or_else(|| StorageError::Validation("expected_updated_at is required on update".into()))?;
        if instance.plugin_id != plugin_id {
          return Err(StorageError::Validation("plugin_id is immutable after create".into()));
        }
        if instance.updated_at != expected {
          return Err(StorageError::Conflict(
            "integration instance changed concurrently".into(),
          ));
        }
        (
          Some(instance.id),
          None,
          instance.plugin_version,
          instance.runtime_kind,
          instance.package_digest,
          Some(expected.to_string()),
        )
      } else {
        if input.expected_updated_at.is_some() {
          return Err(StorageError::Validation(
            "expected_updated_at is only valid for an existing instance".into(),
          ));
        }
        (
          None,
          Some(new_id()),
          registration.manifest.version.clone(),
          "bundled-rust".to_string(),
          None,
          None,
        )
      };

    let runtime_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
      plugin_id: &plugin_id,
      plugin_version: &plugin_version,
      runtime_kind: &runtime_kind,
      package_digest: package_digest.as_deref(),
    });
    let preview_id = format!("ept_{}", new_id().simple());
    let expires_at = Instant::now() + Duration::from_secs(ENDPOINT_TRUST_PREVIEW_TTL_SECS);
    let session = EndpointTrustPreviewSession {
      preview_id: preview_id.clone(),
      instance_id,
      creation_instance_id,
      reserved: false,
      plugin_id: plugin_id.clone(),
      plugin_version,
      endpoint_alias: EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
      normalized_origin: candidate.normalized_base_url.clone(),
      configuration_fingerprint: candidate.configuration_fingerprint,
      runtime_identity_fingerprint: runtime_fingerprint,
      expected_updated_at,
      expires_at,
    };
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .insert(preview_id.clone(), session);

    Ok(EndpointTrustPreviewDto {
      preview_id,
      instance_id,
      plugin_id,
      endpoint_alias: EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
      // `origin` is retained as the wire field name for compatibility; its value is the
      // complete canonical base URL, including an optional path prefix.
      origin: candidate.normalized_base_url,
      method: ENDPOINT_TRUST_METHOD.into(),
      relative_path: ENDPOINT_TRUST_RELATIVE_PATH.into(),
      expires_at: format_preview_expiry(),
    })
  }

  /// Return the current sanitized status without exposing fingerprints or persisted rows.
  pub fn status_for_instance(
    &self,
    conn: &rusqlite::Connection,
    instance: &IntegrationInstance,
  ) -> Result<EndpointTrustStatus, StorageError> {
    if instance.plugin_id != EDGE_TTS_PLUGIN_ID {
      return Ok(EndpointTrustStatus::NotApplicable);
    }
    let registration = self
      .registry
      .get_registration(&instance.plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(instance.plugin_id.clone()))?;
    let normalized_config = registration.config_adapter.normalize_config(&instance.config_json)?;
    let candidate = self.edge_candidate(&normalized_config)?;
    if candidate.normalized_base_url == EDGE_TTS_DEFAULT_BASE_URL {
      return Ok(EndpointTrustStatus::Official);
    }
    let runtime_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
      plugin_id: &instance.plugin_id,
      plugin_version: &instance.plugin_version,
      runtime_kind: &instance.runtime_kind,
      package_digest: instance.package_digest.as_deref(),
    });
    let approved = integration_endpoint_trusts::get_exact(
      conn,
      instance.id,
      &instance.plugin_id,
      &instance.plugin_version,
      EDGE_TTS_TRUST_ENDPOINT_ALIAS,
      &candidate.normalized_base_url,
      &candidate.configuration_fingerprint,
      &runtime_fingerprint,
    )?;
    Ok(if approved.is_some() {
      EndpointTrustStatus::TrustedCustom
    } else {
      EndpointTrustStatus::ReviewRequired
    })
  }

  /// Look up the exact current approval for a runtime/configuration tuple.
  pub fn current_approval(
    &self,
    conn: &rusqlite::Connection,
    instance_id: Uuid,
    plugin_id: &str,
    plugin_version: &str,
    runtime_kind: &str,
    package_digest: Option<&str>,
    normalized_config: &str,
    endpoint_alias: &str,
    normalized_origin: &str,
  ) -> Result<Option<IntegrationEndpointTrust>, StorageError> {
    let configuration_fingerprint = configuration_fingerprint(normalized_config).map_err(StorageError::Validation)?;
    let runtime_identity_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
      plugin_id,
      plugin_version,
      runtime_kind,
      package_digest,
    });
    integration_endpoint_trusts::get_exact(
      conn,
      instance_id,
      plugin_id,
      plugin_version,
      endpoint_alias,
      normalized_origin,
      &configuration_fingerprint,
      &runtime_identity_fingerprint,
    )
  }

  /// Look up an existing custom approval when a save leaves the normalized config unchanged.
  /// Metadata or credential-only saves must not force the user to acknowledge the same endpoint again.
  pub fn current_approval_for_config(
    &self,
    conn: &rusqlite::Connection,
    instance_id: Uuid,
    plugin_id: &str,
    plugin_version: &str,
    runtime_kind: &str,
    package_digest: Option<&str>,
    normalized_config: &str,
  ) -> Result<Option<IntegrationEndpointTrust>, StorageError> {
    if plugin_id != EDGE_TTS_PLUGIN_ID {
      return Ok(None);
    }
    let candidate = self.edge_candidate(normalized_config)?;
    if candidate.normalized_base_url == EDGE_TTS_DEFAULT_BASE_URL {
      return Ok(None);
    }
    self.current_approval(
      conn,
      instance_id,
      plugin_id,
      plugin_version,
      runtime_kind,
      package_digest,
      normalized_config,
      EDGE_TTS_TRUST_ENDPOINT_ALIAS,
      &candidate.normalized_base_url,
    )
  }

  /// Validate and reserve one acknowledgement for an atomic integration save.
  /// The returned row is inserted by the caller inside its existing DB transaction; callers must
  /// commit or roll back the reservation after that transaction completes.
  pub fn consume_for_save(
    &self,
    instance_id: Uuid,
    plugin_id: &str,
    plugin_version: &str,
    runtime_kind: &str,
    package_digest: Option<&str>,
    normalized_config: &str,
    expected_updated_at: Option<&str>,
    preview_id: Option<&str>,
    acknowledge: bool,
  ) -> Result<Option<IntegrationEndpointTrust>, StorageError> {
    if plugin_id != EDGE_TTS_PLUGIN_ID {
      return Ok(None);
    }
    let candidate = self.edge_candidate(normalized_config)?;
    if candidate.normalized_base_url == EDGE_TTS_DEFAULT_BASE_URL {
      if preview_id.is_some() || acknowledge {
        return Err(StorageError::EndpointTrustStale(
          "official Edge TTS base URL does not accept a custom endpoint review".into(),
        ));
      }
      return Ok(None);
    }
    if !acknowledge {
      return Err(StorageError::EndpointTrustRequired(
        "custom Edge TTS endpoint requires acknowledgement".into(),
      ));
    }
    let preview_id = preview_id
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .ok_or_else(|| StorageError::EndpointTrustRequired("custom Edge TTS endpoint requires a host review".into()))?;
    if preview_id.len() > ENDPOINT_TRUST_PREVIEW_ID_MAX_LEN {
      return Err(StorageError::EndpointTrustStale("endpoint review id is invalid".into()));
    }
    self.expire_previews();
    let runtime_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
      plugin_id,
      plugin_version,
      runtime_kind,
      package_digest,
    });
    let mut previews = self.previews.lock().unwrap_or_else(|error| error.into_inner());
    let session = previews
      .get(preview_id)
      .cloned()
      .ok_or_else(|| StorageError::EndpointTrustStale("endpoint review is missing or expired".into()))?;
    if session.expires_at <= Instant::now()
      || (session.instance_id.is_some() && session.instance_id != Some(instance_id))
      || (session.instance_id.is_none() && session.creation_instance_id != Some(instance_id))
      || session.plugin_id != plugin_id
      || session.plugin_version != plugin_version
      || session.endpoint_alias != EDGE_TTS_TRUST_ENDPOINT_ALIAS
      || session.normalized_origin != candidate.normalized_base_url
      || session.reserved
      || session.configuration_fingerprint != candidate.configuration_fingerprint
      || session.runtime_identity_fingerprint != runtime_fingerprint
      || session.expected_updated_at.as_deref() != expected_updated_at
    {
      return Err(StorageError::EndpointTrustStale(
        "endpoint review no longer matches this configuration".into(),
      ));
    }
    if let Some(session) = previews.get_mut(preview_id) {
      session.reserved = true;
    }
    drop(previews);

    Ok(Some(IntegrationEndpointTrust {
      id: new_id(),
      integration_instance_id: instance_id,
      plugin_id: plugin_id.into(),
      plugin_version: plugin_version.into(),
      endpoint_alias: EDGE_TTS_TRUST_ENDPOINT_ALIAS.into(),
      normalized_origin: candidate.normalized_base_url,
      configuration_fingerprint: candidate.configuration_fingerprint,
      runtime_identity_fingerprint: runtime_fingerprint,
      approved_at: now_rfc3339(),
    }))
  }

  /// Return the host-reserved instance id for a create preview.
  pub fn reserved_create_instance_id(&self, preview_id: Option<&str>) -> Result<Option<Uuid>, StorageError> {
    let Some(preview_id) = preview_id.map(str::trim).filter(|value| !value.is_empty()) else {
      return Ok(None);
    };
    let previews = self.previews.lock().unwrap_or_else(|error| error.into_inner());
    let session = previews
      .get(preview_id)
      .ok_or_else(|| StorageError::EndpointTrustStale("endpoint review is missing or expired".into()))?;
    if session.expires_at <= Instant::now() || session.instance_id.is_some() || session.reserved {
      return Err(StorageError::EndpointTrustStale(
        "endpoint review is not valid for a new instance".into(),
      ));
    }
    Ok(session.creation_instance_id)
  }

  /// Commit a preview reservation after its enclosing persistence transaction succeeds.
  pub fn commit_preview_consumption(&self, preview_id: Option<&str>) {
    let Some(preview_id) = preview_id.map(str::trim).filter(|value| !value.is_empty()) else {
      return;
    };
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(preview_id);
  }

  /// Roll back a preview reservation when its enclosing persistence transaction fails.
  pub fn rollback_preview_consumption(&self, preview_id: Option<&str>) {
    let Some(preview_id) = preview_id.map(str::trim).filter(|value| !value.is_empty()) else {
      return;
    };
    if let Some(session) = self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .get_mut(preview_id)
    {
      session.reserved = false;
    }
  }

  /// Remove stale approvals when a normal/default configuration is saved.
  pub fn revoke_for_instance(&self, conn: &rusqlite::Connection, instance_id: Uuid) -> Result<(), StorageError> {
    integration_endpoint_trusts::delete_for_instance(conn, instance_id)
  }

  fn edge_candidate(&self, normalized_config: &str) -> Result<EdgeEndpointCandidate, StorageError> {
    let value: serde_json::Value = serde_json::from_str(normalized_config).map_err(StorageError::from)?;
    let raw = value
      .get("base-url")
      .and_then(serde_json::Value::as_str)
      .unwrap_or(EDGE_TTS_DEFAULT_BASE_URL);
    let normalized = normalize_edge_tts_base_url(raw).map_err(StorageError::Validation)?;
    Ok(EdgeEndpointCandidate {
      normalized_base_url: normalized.canonical_url,
      configuration_fingerprint: configuration_fingerprint(normalized_config).map_err(StorageError::Validation)?,
    })
  }

  fn expire_previews(&self) {
    let now = Instant::now();
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .retain(|_, session| session.expires_at > now);
  }

  #[cfg(test)]
  fn expire_preview_for_test(&self, preview_id: &str) {
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(preview_id);
  }
}

fn format_preview_expiry() -> String {
  format_rfc3339(OffsetDateTime::now_utc() + TimeDuration::seconds(ENDPOINT_TRUST_PREVIEW_TTL_SECS as i64))
    .unwrap_or_else(|_| now_rfc3339())
}

/// Map the classifier to a stable execution decision for callers that need one shared seam.
pub fn classify_for_execution(
  plugin_id: &str,
  endpoint_alias: &str,
  normalized_origin: &str,
  origin_kind: Option<crate::domain::runtime_plugin::NetworkOriginKind>,
  current_approval: bool,
) -> EndpointEgressPolicy {
  classify_endpoint_egress(
    plugin_id,
    endpoint_alias,
    normalized_origin,
    origin_kind,
    current_approval,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::endpoint_trust::EndpointTrustPreviewInput;
  use crate::domain::service_integration::{
    EDGE_TTS_PLUGIN_ID, EdgeTtsConfigV1, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::integration_endpoint_trusts;

  fn setup() -> (tempfile::TempDir, EndpointTrustService, Database, Uuid) {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::new(directory.path()).unwrap();
    database.initialize().unwrap();
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let service = EndpointTrustService::new(database.clone(), registry);
    let instance_id = new_id();
    let now = now_rfc3339();
    database
      .transaction(|unit| {
        crate::repositories::integration_instances::insert(
          unit.conn(),
          &IntegrationInstance {
            id: instance_id,
            plugin_id: EDGE_TTS_PLUGIN_ID.into(),
            plugin_version: "1.0.0".into(),
            display_name: "Edge".into(),
            enabled: true,
            config_json: serde_json::to_string(&EdgeTtsConfigV1 {
              base_url: "https://custom.example/api".into(),
            })
            .unwrap(),
            config_schema_version: 1,
            health_status: IntegrationHealthStatus::Ready,
            last_validated_at: None,
            last_error_code: None,
            runtime_kind: "bundled-rust".into(),
            package_digest: None,
            execution_grant_set_revision: None,
            runtime_state: "active".into(),
            runtime_error_code: None,
            runtime_error_message: None,
            runtime_requirement_json: None,
            created_at: now.clone(),
            updated_at: now,
          },
        )?;
        Ok(())
      })
      .unwrap();
    (directory, service, database, instance_id)
  }

  #[test]
  fn preview_is_sanitized_and_non_mutating() {
    let (_directory, service, database, instance_id) = setup();
    let preview = service
      .preview(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: Some(instance_id),
        config_json: r#"{"base-url":"https://custom.example/api/"}"#.into(),
        expected_updated_at: Some(
          database
            .read(|conn| Ok(crate::repositories::integration_instances::get(conn, instance_id)?.updated_at))
            .unwrap(),
        ),
      })
      .unwrap();
    assert_eq!(preview.origin, "https://custom.example/api");
    assert_eq!(preview.method, ENDPOINT_TRUST_METHOD);
    assert_eq!(preview.relative_path, ENDPOINT_TRUST_RELATIVE_PATH);
    assert!(preview.preview_id.starts_with("ept_"));
    assert_eq!(
      database
        .read(|conn| integration_endpoint_trusts::count_for_instance(conn, instance_id))
        .unwrap(),
      0
    );
  }

  #[test]
  fn preview_rejects_invalid_url_shapes() {
    let (_directory, service, database, instance_id) = setup();
    let updated_at = database
      .read(|conn| Ok(crate::repositories::integration_instances::get(conn, instance_id)?.updated_at))
      .unwrap();
    for base_url in [
      "http://custom.example",
      "https://127.0.0.1",
      "https://localhost",
      "https://user:pass@custom.example",
      "https://custom.example?token=secret",
      "https://custom.example/#fragment",
    ] {
      let result = service.preview(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: Some(instance_id),
        config_json: serde_json::json!({"base-url": base_url}).to_string(),
        expected_updated_at: Some(updated_at.clone()),
      });
      assert!(result.is_err(), "{base_url} must be rejected");
    }
  }

  #[test]
  fn stale_revision_and_missing_preview_fail_closed() {
    let (_directory, service, _database, instance_id) = setup();
    let error = service
      .preview(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: Some(instance_id),
        config_json: r#"{"base-url":"https://custom.example"}"#.into(),
        expected_updated_at: Some("stale".into()),
      })
      .unwrap_err();
    assert!(matches!(error, StorageError::Conflict(_)));
    let error = service
      .consume_for_save(
        instance_id,
        EDGE_TTS_PLUGIN_ID,
        "1.0.0",
        "bundled-rust",
        None,
        r#"{"base-url":"https://custom.example"}"#,
        Some("t"),
        Some("missing"),
        true,
      )
      .unwrap_err();
    assert!(matches!(error, StorageError::EndpointTrustStale(_)));
  }

  #[test]
  fn create_preview_is_bound_and_rollback_does_not_consume_it() {
    let (_directory, service, _database, _instance_id) = setup();
    let preview = service
      .preview(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: None,
        config_json: r#"{"base-url":"https://custom.example"}"#.into(),
        expected_updated_at: None,
      })
      .unwrap();
    let reserved_id = service
      .reserved_create_instance_id(Some(&preview.preview_id))
      .unwrap()
      .expect("create preview must reserve an instance id");
    let wrong_id = new_id();
    let error = service
      .consume_for_save(
        wrong_id,
        EDGE_TTS_PLUGIN_ID,
        "1.0.0",
        "bundled-rust",
        None,
        r#"{"base-url":"https://custom.example"}"#,
        None,
        Some(&preview.preview_id),
        true,
      )
      .unwrap_err();
    assert!(matches!(error, StorageError::EndpointTrustStale(_)));
    let trust = service
      .consume_for_save(
        reserved_id,
        EDGE_TTS_PLUGIN_ID,
        "1.0.0",
        "bundled-rust",
        None,
        r#"{"base-url":"https://custom.example"}"#,
        None,
        Some(&preview.preview_id),
        true,
      )
      .unwrap()
      .expect("reserved create preview should be consumable");
    service.rollback_preview_consumption(Some(&preview.preview_id));
    assert!(
      service
        .consume_for_save(
          reserved_id,
          EDGE_TTS_PLUGIN_ID,
          "1.0.0",
          "bundled-rust",
          None,
          r#"{"base-url":"https://custom.example"}"#,
          None,
          Some(&preview.preview_id),
          true,
        )
        .is_ok()
    );
    service.commit_preview_consumption(Some(&preview.preview_id));
    let error = service
      .consume_for_save(
        reserved_id,
        EDGE_TTS_PLUGIN_ID,
        "1.0.0",
        "bundled-rust",
        None,
        r#"{"base-url":"https://custom.example"}"#,
        None,
        Some(&preview.preview_id),
        true,
      )
      .unwrap_err();
    assert!(matches!(error, StorageError::EndpointTrustStale(_)));
    let _ = trust;
  }

  #[test]
  fn expired_preview_is_not_consumable() {
    let (_directory, service, database, instance_id) = setup();
    let updated_at = database
      .read(|conn| Ok(crate::repositories::integration_instances::get(conn, instance_id)?.updated_at))
      .unwrap();
    let preview = service
      .preview(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: Some(instance_id),
        config_json: r#"{"base-url":"https://custom.example"}"#.into(),
        expected_updated_at: Some(updated_at.clone()),
      })
      .unwrap();
    service.expire_preview_for_test(&preview.preview_id);
    let error = service
      .consume_for_save(
        instance_id,
        EDGE_TTS_PLUGIN_ID,
        "1.0.0",
        "bundled-rust",
        None,
        r#"{"base-url":"https://custom.example"}"#,
        Some(&updated_at),
        Some(&preview.preview_id),
        true,
      )
      .unwrap_err();
    assert!(matches!(error, StorageError::EndpointTrustStale(_)));
  }
}
