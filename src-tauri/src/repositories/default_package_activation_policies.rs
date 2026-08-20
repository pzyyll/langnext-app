// ABOUTME: SQLite access for default package activation policies and subject intents.
// ABOUTME: Policies are future-instance templates; intents never store secrets.
use crate::domain::default_package_activation::{
  DefaultActivationPolicySource, DefaultPackageActivationPolicy, DefaultPackageAuthorizationStatus,
  DefaultRuntimeActivationIntent, DefaultRuntimeActivationSource, DefaultRuntimeActivationState,
  DefaultRuntimeAuthorityApproval,
};
use crate::domain::runtime_lifecycle::GrantSubjectKind;
use crate::domain::time::now_rfc3339;
use crate::error::StorageError;
use crate::repositories::{installed_plugin_versions, plugin_publishers};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

fn map_policy(row: &Row<'_>) -> Result<DefaultPackageActivationPolicy, rusqlite::Error> {
  let policy_source: String = row.get("policy_source")?;
  Ok(DefaultPackageActivationPolicy {
    plugin_id: row.get("plugin_id")?,
    package_digest: row.get("package_digest")?,
    publisher_key_id: row.get("publisher_key_id")?,
    publisher_fingerprint: row.get("publisher_fingerprint")?,
    permission_request_digest: row.get("permission_request_digest")?,
    approved_authority_constraints_json: row.get("approved_authority_constraints_json")?,
    approved_authority_constraints_digest: row.get("approved_authority_constraints_digest")?,
    policy_source: DefaultActivationPolicySource::parse(&policy_source).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

fn map_intent(row: &Row<'_>) -> Result<DefaultRuntimeActivationIntent, rusqlite::Error> {
  let id: String = row.get("id")?;
  let subject_id: String = row.get("subject_id")?;
  let subject_kind: String = row.get("subject_kind")?;
  let source: String = row.get("source")?;
  let state: String = row.get("state")?;
  Ok(DefaultRuntimeActivationIntent {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    subject_kind: GrantSubjectKind::parse(&subject_kind).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    subject_id: Uuid::parse_str(&subject_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    package_digest: row.get("package_digest")?,
    source: DefaultRuntimeActivationSource::parse(&source).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    state: DefaultRuntimeActivationState::parse(&state).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    expected_config_digest: row.get("expected_config_digest")?,
    expected_update_token: row.get("expected_update_token")?,
    error_code: row.get("error_code")?,
    error_message: row.get("error_message")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
    claim_token: row.get("claim_token")?,
    claim_expires_at: row.get("claim_expires_at")?,
  })
}

pub fn get_policy(conn: &Connection, plugin_id: &str) -> Result<Option<DefaultPackageActivationPolicy>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_default_activation_policies WHERE plugin_id = ?1",
        params![plugin_id],
        map_policy,
      )
      .optional()?,
  )
}

pub fn get_policy_by_digest(
  conn: &Connection,
  package_digest: &str,
) -> Result<Option<DefaultPackageActivationPolicy>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM plugin_default_activation_policies WHERE package_digest = ?1",
        params![package_digest],
        map_policy,
      )
      .optional()?,
  )
}

pub fn list_policies(conn: &Connection) -> Result<Vec<DefaultPackageActivationPolicy>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM plugin_default_activation_policies
     ORDER BY plugin_id ASC",
  )?;
  let rows = stmt.query_map([], map_policy)?.collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

pub fn upsert_policy(
  conn: &Connection,
  policy: &DefaultPackageActivationPolicy,
) -> Result<DefaultPackageActivationPolicy, StorageError> {
  conn
    .execute(
      "INSERT INTO plugin_default_activation_policies (
            plugin_id, package_digest, publisher_key_id, publisher_fingerprint,
            permission_request_digest, approved_authority_constraints_json,
            approved_authority_constraints_digest, policy_source, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(plugin_id) DO UPDATE SET
          package_digest = excluded.package_digest,
          publisher_key_id = excluded.publisher_key_id,
          publisher_fingerprint = excluded.publisher_fingerprint,
          permission_request_digest = excluded.permission_request_digest,
          approved_authority_constraints_json = excluded.approved_authority_constraints_json,
          approved_authority_constraints_digest = excluded.approved_authority_constraints_digest,
          policy_source = excluded.policy_source,
          updated_at = excluded.updated_at",
      params![
        policy.plugin_id,
        policy.package_digest,
        policy.publisher_key_id,
        policy.publisher_fingerprint,
        policy.permission_request_digest,
        policy.approved_authority_constraints_json,
        policy.approved_authority_constraints_digest,
        policy.policy_source.as_str(),
        policy.created_at,
        policy.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "default package activation policy"))?;
  get_policy(conn, &policy.plugin_id)?
    .ok_or_else(|| StorageError::Internal("default package activation policy missing after upsert".into()))
}

pub fn delete_policy(conn: &Connection, plugin_id: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_default_activation_policies WHERE plugin_id = ?1",
    params![plugin_id],
  )?;
  Ok(())
}

pub fn delete_policy_if_digest_matches(conn: &Connection, package_digest: &str) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM plugin_default_activation_policies WHERE package_digest = ?1",
    params![package_digest],
  )?;
  Ok(())
}

/// Resolve authorization status for a catalog default against the installed package identity.
///
/// An old `plugin_default_versions` row without a policy is always `Unauthorized`.
/// A policy is `Stale` when digest, publisher identity, permission digest, content availability,
/// or current publisher trust (`enabled` / `revoked` / missing / identity mismatch) differs.
pub fn resolve_authorization_status(
  conn: &Connection,
  plugin_id: &str,
) -> Result<DefaultPackageAuthorizationStatus, StorageError> {
  let Some(default) = installed_plugin_versions::get_default(conn, plugin_id)? else {
    return Ok(DefaultPackageAuthorizationStatus::Absent);
  };
  let Some(policy) = get_policy(conn, plugin_id)? else {
    return Ok(DefaultPackageAuthorizationStatus::Unauthorized);
  };
  let version = installed_plugin_versions::get_optional(conn, &default.package_digest)?;
  let Some(version) = version else {
    return Ok(DefaultPackageAuthorizationStatus::Stale);
  };
  if !version.content_available
    || policy.package_digest != default.package_digest
    || policy.package_digest != version.package_digest
    || policy.publisher_key_id != version.publisher_key_id
    || policy.publisher_fingerprint != version.publisher_fingerprint
    || policy.permission_request_digest != version.permission_request_digest
  {
    return Ok(DefaultPackageAuthorizationStatus::Stale);
  }
  // Current publisher trust participates in every policy decision; missing rows are stale.
  let Some(publisher) = plugin_publishers::get_optional(conn, &policy.publisher_key_id)? else {
    return Ok(DefaultPackageAuthorizationStatus::Stale);
  };
  if publisher.revoked
    || !publisher.enabled
    || publisher.key_id != policy.publisher_key_id
    || publisher.fingerprint != policy.publisher_fingerprint
  {
    return Ok(DefaultPackageAuthorizationStatus::Stale);
  }
  Ok(DefaultPackageAuthorizationStatus::Authorized)
}

pub fn get_intent(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
) -> Result<Option<DefaultRuntimeActivationIntent>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM default_runtime_activation_intents
         WHERE subject_kind = ?1 AND subject_id = ?2",
        params![subject_kind.as_str(), subject_id.to_string()],
        map_intent,
      )
      .optional()?,
  )
}

pub fn get_intent_by_id(conn: &Connection, id: Uuid) -> Result<Option<DefaultRuntimeActivationIntent>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM default_runtime_activation_intents WHERE id = ?1",
        params![id.to_string()],
        map_intent,
      )
      .optional()?,
  )
}

pub fn insert_intent(conn: &Connection, intent: &DefaultRuntimeActivationIntent) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO default_runtime_activation_intents (
            id, subject_kind, subject_id, package_digest, source, state,
            expected_config_digest, expected_update_token, error_code, error_message,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      params![
        intent.id.to_string(),
        intent.subject_kind.as_str(),
        intent.subject_id.to_string(),
        intent.package_digest,
        intent.source.as_str(),
        intent.state.as_str(),
        intent.expected_config_digest,
        intent.expected_update_token,
        intent.error_code,
        intent.error_message,
        intent.created_at,
        intent.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "default runtime activation intent"))?;
  Ok(())
}

pub fn update_intent_state(
  conn: &Connection,
  id: Uuid,
  state: DefaultRuntimeActivationState,
  error_code: Option<&str>,
  error_message: Option<&str>,
) -> Result<DefaultRuntimeActivationIntent, StorageError> {
  let updated_at = now_rfc3339();
  let changed = conn.execute(
    "UPDATE default_runtime_activation_intents
     SET state = ?2, error_code = ?3, error_message = ?4, updated_at = ?5,
         claim_token = NULL, claim_expires_at = NULL
     WHERE id = ?1",
    params![id.to_string(), state.as_str(), error_code, error_message, updated_at],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "default runtime activation intent {id}"
    )));
  }
  get_intent_by_id(conn, id)?.ok_or_else(|| StorageError::NotFound(format!("default runtime activation intent {id}")))
}

/// Reset a retained intent to pending with the post-confirm config binding.
pub fn reset_intent_pending_with_binding(
  conn: &Connection,
  id: Uuid,
  expected_config_digest: Option<&str>,
  expected_update_token: Option<&str>,
) -> Result<DefaultRuntimeActivationIntent, StorageError> {
  let updated_at = now_rfc3339();
  let changed = conn.execute(
    "UPDATE default_runtime_activation_intents
     SET state = ?2, error_code = NULL, error_message = NULL,
         expected_config_digest = ?3, expected_update_token = ?4,
         claim_token = NULL, claim_expires_at = NULL, updated_at = ?5
     WHERE id = ?1",
    params![
      id.to_string(),
      DefaultRuntimeActivationState::Pending.as_str(),
      expected_config_digest,
      expected_update_token,
      updated_at
    ],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "default runtime activation intent {id}"
    )));
  }
  get_intent_by_id(conn, id)?.ok_or_else(|| StorageError::NotFound(format!("default runtime activation intent {id}")))
}

/// Mark an intent failed and bind it to the post-failure subject update token.
///
/// Callers must CAS the subject to unavailable with the same `expected_update_token` first so
/// retry can re-check the exact failure transition without manual digest entry.
pub fn fail_intent_with_update_token(
  conn: &Connection,
  id: Uuid,
  error_code: &str,
  error_message: &str,
  expected_update_token: &str,
) -> Result<DefaultRuntimeActivationIntent, StorageError> {
  let updated_at = now_rfc3339();
  let changed = conn.execute(
    "UPDATE default_runtime_activation_intents
     SET state = ?2, error_code = ?3, error_message = ?4,
         expected_update_token = ?5,
         claim_token = NULL, claim_expires_at = NULL, updated_at = ?6
     WHERE id = ?1",
    params![
      id.to_string(),
      DefaultRuntimeActivationState::Failed.as_str(),
      error_code,
      error_message,
      expected_update_token,
      updated_at
    ],
  )?;
  if changed == 0 {
    return Err(StorageError::NotFound(format!(
      "default runtime activation intent {id}"
    )));
  }
  get_intent_by_id(conn, id)?.ok_or_else(|| StorageError::NotFound(format!("default runtime activation intent {id}")))
}

fn map_approval(row: &Row<'_>) -> Result<DefaultRuntimeAuthorityApproval, rusqlite::Error> {
  let id: String = row.get("id")?;
  let subject_id: String = row.get("subject_id")?;
  let subject_kind: String = row.get("subject_kind")?;
  Ok(DefaultRuntimeAuthorityApproval {
    id: Uuid::parse_str(&id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    subject_kind: GrantSubjectKind::parse(&subject_kind).map_err(|e| {
      rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
      )
    })?,
    subject_id: Uuid::parse_str(&subject_id)
      .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
    package_digest: row.get("package_digest")?,
    config_digest: row.get("config_digest")?,
    subject_update_token: row.get("subject_update_token")?,
    policy_constraints_digest: row.get("policy_constraints_digest")?,
    approved_authority_json: row.get("approved_authority_json")?,
    approved_authority_digest: row.get("approved_authority_digest")?,
    created_at: row.get("created_at")?,
    updated_at: row.get("updated_at")?,
  })
}

/// Insert one exact additive authority approval.
pub fn insert_authority_approval(
  conn: &Connection,
  approval: &DefaultRuntimeAuthorityApproval,
) -> Result<(), StorageError> {
  conn
    .execute(
      "INSERT INTO default_runtime_authority_approvals (
            id, subject_kind, subject_id, package_digest, config_digest, subject_update_token,
            policy_constraints_digest, approved_authority_json, approved_authority_digest,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      params![
        approval.id.to_string(),
        approval.subject_kind.as_str(),
        approval.subject_id.to_string(),
        approval.package_digest,
        approval.config_digest,
        approval.subject_update_token,
        approval.policy_constraints_digest,
        approval.approved_authority_json,
        approval.approved_authority_digest,
        approval.created_at,
        approval.updated_at,
      ],
    )
    .map_err(|e| StorageError::from_sqlite_constraint(e, "default runtime authority approval"))?;
  Ok(())
}

/// Exact lookup of a live approval for the subject/config/package/policy binding.
pub fn get_authority_approval_exact(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
  config_digest: &str,
  subject_update_token: &str,
  policy_constraints_digest: &str,
) -> Result<Option<DefaultRuntimeAuthorityApproval>, StorageError> {
  Ok(
    conn
      .query_row(
        "SELECT * FROM default_runtime_authority_approvals
         WHERE subject_kind = ?1 AND subject_id = ?2 AND package_digest = ?3
           AND config_digest = ?4 AND subject_update_token = ?5
           AND policy_constraints_digest = ?6",
        params![
          subject_kind.as_str(),
          subject_id.to_string(),
          package_digest,
          config_digest,
          subject_update_token,
          policy_constraints_digest
        ],
        map_approval,
      )
      .optional()?,
  )
}

/// Delete all approvals for a subject (activation success or subject removal).
pub fn delete_authority_approvals_for_subject(
  conn: &Connection,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
) -> Result<usize, StorageError> {
  let changed = conn.execute(
    "DELETE FROM default_runtime_authority_approvals
     WHERE subject_kind = ?1 AND subject_id = ?2",
    params![subject_kind.as_str(), subject_id.to_string()],
  )?;
  Ok(changed)
}

/// Exact final CAS: current catalog default, policy identity, and intent still match the snapshot.
pub fn assert_final_default_policy_intent_cas(
  conn: &Connection,
  plugin_id: &str,
  package_digest: &str,
  policy_constraints_digest: &str,
  publisher_key_id: &str,
  publisher_fingerprint: &str,
  intent_id: Uuid,
  intent_source: DefaultRuntimeActivationSource,
  expected_intent_state: DefaultRuntimeActivationState,
) -> Result<(), StorageError> {
  let default = installed_plugin_versions::get_default(conn, plugin_id)?.ok_or_else(|| {
    StorageError::Conflict("default_authorization_stale: catalog default missing at grant CAS".into())
  })?;
  if default.package_digest != package_digest {
    return Err(StorageError::Conflict(
      "default_authorization_stale: catalog default digest changed before grant".into(),
    ));
  }
  let policy = get_policy(conn, plugin_id)?.ok_or_else(|| {
    StorageError::Conflict("default_authorization_stale: activation policy missing at grant CAS".into())
  })?;
  if policy.package_digest != package_digest
    || policy.publisher_key_id != publisher_key_id
    || policy.publisher_fingerprint != publisher_fingerprint
    || policy.approved_authority_constraints_digest != policy_constraints_digest
  {
    return Err(StorageError::Conflict(
      "default_authorization_stale: activation policy identity changed before grant".into(),
    ));
  }
  let intent = get_intent_by_id(conn, intent_id)?.ok_or_else(|| {
    StorageError::Conflict("default_authorization_stale: activation intent missing at grant CAS".into())
  })?;
  if intent.package_digest != package_digest || intent.source != intent_source || intent.state != expected_intent_state
  {
    return Err(StorageError::Conflict(
      "default_authorization_stale: activation intent binding changed before grant".into(),
    ));
  }
  Ok(())
}

/// List recovery-eligible local creation intents that are still pending or activating.
pub fn list_recovery_eligible_intents(conn: &Connection) -> Result<Vec<DefaultRuntimeActivationIntent>, StorageError> {
  let mut stmt = conn.prepare(
    "SELECT * FROM default_runtime_activation_intents
     WHERE source = ?1 AND state IN (?2, ?3)
     ORDER BY created_at ASC, id ASC",
  )?;
  let rows = stmt
    .query_map(
      params![
        DefaultRuntimeActivationSource::LocalCreation.as_str(),
        DefaultRuntimeActivationState::Pending.as_str(),
        DefaultRuntimeActivationState::Activating.as_str(),
      ],
      map_intent,
    )?
    .collect::<Result<Vec<_>, _>>()?;
  Ok(rows)
}

/// Claim a bounded batch of recovery-eligible local intents with a durable lease.
///
/// Selects only rows with no claim or an expired claim, CAS-updates them with the caller token,
/// and returns only rows owned by that token.
pub fn claim_recovery_eligible_intents(
  conn: &Connection,
  claim_token: &str,
  now_rfc3339: &str,
  lease_expires_at: &str,
  batch_limit: usize,
) -> Result<Vec<DefaultRuntimeActivationIntent>, StorageError> {
  let candidates = list_recovery_eligible_intents(conn)?;
  let mut claimed = Vec::new();
  for intent in candidates {
    if claimed.len() >= batch_limit {
      break;
    }
    let claim_open = match (&intent.claim_token, &intent.claim_expires_at) {
      (None, _) => true,
      (Some(_), Some(expires_at)) => expires_at.as_str() <= now_rfc3339,
      (Some(_), None) => true,
    };
    if !claim_open {
      continue;
    }
    let changed = conn.execute(
      "UPDATE default_runtime_activation_intents
       SET claim_token = ?2, claim_expires_at = ?3, updated_at = ?4
       WHERE id = ?1
         AND source = ?5
         AND state IN (?6, ?7)
         AND (
           claim_token IS NULL
           OR claim_expires_at IS NULL
           OR claim_expires_at <= ?4
         )",
      params![
        intent.id.to_string(),
        claim_token,
        lease_expires_at,
        now_rfc3339,
        DefaultRuntimeActivationSource::LocalCreation.as_str(),
        DefaultRuntimeActivationState::Pending.as_str(),
        DefaultRuntimeActivationState::Activating.as_str(),
      ],
    )?;
    if changed == 1 {
      if let Some(row) = get_intent_by_id(conn, intent.id)? {
        if row.claim_token.as_deref() == Some(claim_token) {
          claimed.push(row);
        }
      }
    }
  }
  Ok(claimed)
}

/// Renew a claim only when the caller still owns the token.
pub fn renew_recovery_claim(
  conn: &Connection,
  intent_id: Uuid,
  claim_token: &str,
  now_rfc3339: &str,
  lease_expires_at: &str,
) -> Result<bool, StorageError> {
  let changed = conn.execute(
    "UPDATE default_runtime_activation_intents
     SET claim_expires_at = ?3, updated_at = ?4
     WHERE id = ?1 AND claim_token = ?2",
    params![intent_id.to_string(), claim_token, lease_expires_at, now_rfc3339],
  )?;
  Ok(changed == 1)
}

/// CAS-transition a claim-owned local intent to `activating` and renew its lease.
///
/// Returns the updated row only when intent ID, `local_creation`, recoverable state, claim token,
/// and unexpired lease all match. A lost or expired claim yields `None`.
pub fn transition_claimed_intent_to_activating(
  conn: &Connection,
  intent_id: Uuid,
  claim_token: &str,
  now_rfc3339: &str,
  lease_expires_at: &str,
) -> Result<Option<DefaultRuntimeActivationIntent>, StorageError> {
  let changed = conn.execute(
    "UPDATE default_runtime_activation_intents
     SET state = ?5, claim_expires_at = ?3, updated_at = ?4
     WHERE id = ?1
       AND claim_token = ?2
       AND source = ?6
       AND state IN (?7, ?8)
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at > ?4",
    params![
      intent_id.to_string(),
      claim_token,
      lease_expires_at,
      now_rfc3339,
      DefaultRuntimeActivationState::Activating.as_str(),
      DefaultRuntimeActivationSource::LocalCreation.as_str(),
      DefaultRuntimeActivationState::Pending.as_str(),
      DefaultRuntimeActivationState::Activating.as_str(),
    ],
  )?;
  if changed != 1 {
    return Ok(None);
  }
  let row = get_intent_by_id(conn, intent_id)?;
  Ok(row.filter(|intent| {
    intent.claim_token.as_deref() == Some(claim_token) && intent.state == DefaultRuntimeActivationState::Activating
  }))
}

/// True when the claim token still owns the intent and the lease has not expired.
pub fn assert_recovery_claim_owner(
  conn: &Connection,
  intent_id: Uuid,
  claim_token: &str,
  now_rfc3339: &str,
) -> Result<bool, StorageError> {
  let Some(intent) = get_intent_by_id(conn, intent_id)? else {
    return Ok(false);
  };
  if intent.source != DefaultRuntimeActivationSource::LocalCreation {
    return Ok(false);
  }
  if intent.claim_token.as_deref() != Some(claim_token) {
    return Ok(false);
  }
  match intent.claim_expires_at.as_deref() {
    Some(expires_at) if expires_at > now_rfc3339 => Ok(true),
    _ => Ok(false),
  }
}

/// Clear claim fields; used when completing, failing, or cancelling an intent.
pub fn clear_recovery_claim(conn: &Connection, intent_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "UPDATE default_runtime_activation_intents
     SET claim_token = NULL, claim_expires_at = NULL
     WHERE id = ?1",
    params![intent_id.to_string()],
  )?;
  Ok(())
}

pub fn delete_intent(conn: &Connection, subject_kind: GrantSubjectKind, subject_id: Uuid) -> Result<(), StorageError> {
  conn.execute(
    "DELETE FROM default_runtime_activation_intents
     WHERE subject_kind = ?1 AND subject_id = ?2",
    params![subject_kind.as_str(), subject_id.to_string()],
  )?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_package::{InstalledPluginVersion, PluginPublisher, PublisherSource};
  use crate::domain::runtime_plugin::SHA256_HEX_LEN;
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::plugin_publishers;
  use crate::storage::Database;

  fn setup() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    (dir, db)
  }

  fn seed_package(
    conn: &Connection,
    plugin_id: &str,
    digest: &str,
    publisher_key_id: &str,
    fingerprint: &str,
    permission_digest: &str,
  ) {
    let now = now_rfc3339();
    plugin_publishers::insert(
      conn,
      &PluginPublisher {
        key_id: publisher_key_id.into(),
        fingerprint: fingerprint.into(),
        public_key_hex: "a".repeat(SHA256_HEX_LEN),
        source: PublisherSource::Vendor,
        enabled: true,
        revoked: false,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )
    .unwrap();
    installed_plugin_versions::insert(
      conn,
      &InstalledPluginVersion {
        package_digest: digest.into(),
        plugin_id: plugin_id.into(),
        version: "1.0.0".into(),
        publisher_key_id: publisher_key_id.into(),
        publisher_fingerprint: fingerprint.into(),
        runtime_kind: "wasm-component".into(),
        manifest_json: "{}".into(),
        permission_request_digest: permission_digest.into(),
        content_available: true,
        installed_at: now,
      },
    )
    .unwrap();
  }

  #[test]
  fn existing_default_without_policy_is_unauthorized() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Unauthorized);
    assert!(db.read(|conn| get_policy(conn, plugin_id)).unwrap().is_none());
    assert!(
      db.read(|conn| installed_plugin_versions::get_default(conn, plugin_id))
        .unwrap()
        .is_some()
    );
  }

  #[test]
  fn policy_round_trip_and_exact_match_is_authorized() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: fingerprint.clone(),
          permission_request_digest: permission.clone(),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let policy = db.read(|conn| get_policy(conn, plugin_id)).unwrap().unwrap();
    assert_eq!(policy.package_digest, digest);
    assert_eq!(policy.policy_source, DefaultActivationPolicySource::UserConfirmed);
    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Authorized);
  }

  #[test]
  fn policy_is_stale_when_permission_digest_differs() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: fingerprint.clone(),
          permission_request_digest: "f".repeat(SHA256_HEX_LEN),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::VendorBootstrap,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Stale);
  }

  #[test]
  fn default_package_policy_publisher_trust_disabled_is_stale() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: fingerprint.clone(),
          permission_request_digest: permission.clone(),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      plugin_publishers::set_enabled(uow.conn(), key_id, false)?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Stale);
    // Policy row is preserved for audit/reauthorization UI.
    assert!(db.read(|conn| get_policy(conn, plugin_id)).unwrap().is_some());
  }

  #[test]
  fn default_package_policy_publisher_trust_revoked_is_stale() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: fingerprint.clone(),
          permission_request_digest: permission.clone(),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      plugin_publishers::revoke(uow.conn(), key_id)?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Stale);
  }

  #[test]
  fn default_package_policy_publisher_trust_identity_mismatch_is_stale() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: "f".repeat(SHA256_HEX_LEN),
          permission_request_digest: permission.clone(),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Stale);
  }

  #[test]
  fn policy_is_stale_when_content_unavailable() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      installed_plugin_versions::set_default(uow.conn(), plugin_id, &digest)?;
      upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: plugin_id.into(),
          package_digest: digest.clone(),
          publisher_key_id: key_id.into(),
          publisher_fingerprint: fingerprint.clone(),
          permission_request_digest: permission.clone(),
          approved_authority_constraints_json: r#"{"network":[]}"#.into(),
          approved_authority_constraints_digest: "e".repeat(SHA256_HEX_LEN),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      installed_plugin_versions::set_content_available(uow.conn(), &digest, false)?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    let status = db.read(|conn| resolve_authorization_status(conn, plugin_id)).unwrap();
    assert_eq!(status, DefaultPackageAuthorizationStatus::Stale);
  }

  #[test]
  fn activation_intents_preserve_local_and_import_sources() {
    let (_dir, db) = setup();
    let plugin_id = "com.example.translate";
    let digest = "b".repeat(SHA256_HEX_LEN);
    let key_id = "publisher-1";
    let fingerprint = "c".repeat(SHA256_HEX_LEN);
    let permission = "d".repeat(SHA256_HEX_LEN);
    let local_id = new_id();
    let import_id = new_id();
    let local_subject = new_id();
    let import_subject = new_id();
    let now = now_rfc3339();

    db.transaction(|uow| {
      seed_package(uow.conn(), plugin_id, &digest, key_id, &fingerprint, &permission);
      insert_intent(
        uow.conn(),
        &DefaultRuntimeActivationIntent {
          id: local_id,
          subject_kind: GrantSubjectKind::IntegrationInstance,
          subject_id: local_subject,
          package_digest: digest.clone(),
          source: DefaultRuntimeActivationSource::LocalCreation,
          state: DefaultRuntimeActivationState::Pending,
          expected_config_digest: Some("cfg-local".into()),
          expected_update_token: Some("tok-local".into()),
          error_code: None,
          error_message: None,
          created_at: now.clone(),
          updated_at: now.clone(),
          claim_token: None,
          claim_expires_at: None,
        },
      )?;
      insert_intent(
        uow.conn(),
        &DefaultRuntimeActivationIntent {
          id: import_id,
          subject_kind: GrantSubjectKind::ProviderInstance,
          subject_id: import_subject,
          package_digest: digest.clone(),
          source: DefaultRuntimeActivationSource::ImportRequiresConfirmation,
          state: DefaultRuntimeActivationState::Pending,
          expected_config_digest: Some("cfg-import".into()),
          expected_update_token: Some("tok-import".into()),
          error_code: None,
          error_message: None,
          created_at: now.clone(),
          updated_at: now,
          claim_token: None,
          claim_expires_at: None,
        },
      )?;
      Ok::<_, StorageError>(())
    })
    .unwrap();

    // Re-open through a fresh connection to prove durability.
    let local = db
      .read(|conn| get_intent(conn, GrantSubjectKind::IntegrationInstance, local_subject))
      .unwrap()
      .unwrap();
    let import = db
      .read(|conn| get_intent(conn, GrantSubjectKind::ProviderInstance, import_subject))
      .unwrap()
      .unwrap();
    assert_eq!(local.source, DefaultRuntimeActivationSource::LocalCreation);
    assert_eq!(
      import.source,
      DefaultRuntimeActivationSource::ImportRequiresConfirmation
    );
    assert!(local.source.is_recovery_eligible());
    assert!(!import.source.is_recovery_eligible());

    let recovery = db.read(list_recovery_eligible_intents).unwrap();
    assert_eq!(recovery.len(), 1);
    assert_eq!(recovery[0].id, local_id);
  }
}
