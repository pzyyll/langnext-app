// ABOUTME: Provider instance CRUD and credential-reference updates against SQLite.
// ABOUTME: SQL uses bound parameters; uniqueness and FK failures become domain errors.
use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode};
use crate::error::StorageError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<ProviderInstance, rusqlite::Error> {
	let id: String = row.get("id")?;
	let credential_kind: String = row.get("credential_kind")?;
	let proxy_mode: String = row.get("proxy_mode")?;
	let models_sync_status: String = row.get("models_sync_status")?;
	let enabled: i64 = row.get("enabled")?;
	Ok(ProviderInstance {
		id: Uuid::parse_str(&id)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
		adapter_id: row.get("adapter_id")?,
		display_name: row.get("display_name")?,
		base_url_override: row.get("base_url_override")?,
		credential_kind: CredentialKind::parse(&credential_kind)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
		credential_ref: row.get("credential_ref")?,
		enabled: enabled != 0,
		proxy_mode: ProxyMode::parse(&proxy_mode)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
		insecure_http_confirmed_at: row.get("insecure_http_confirmed_at")?,
		models_synced_at: row.get("models_synced_at")?,
		models_sync_status: ModelsSyncStatus::parse(&models_sync_status)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
		models_sync_error_code: row.get("models_sync_error_code")?,
		created_at: row.get("created_at")?,
		updated_at: row.get("updated_at")?,
	})
}

pub fn list(conn: &Connection) -> Result<Vec<ProviderInstance>, StorageError> {
	let mut stmt = conn.prepare("SELECT * FROM provider_instances ORDER BY sort_order ASC, created_at ASC, id ASC")?;
	let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
	Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<ProviderInstance, StorageError> {
	conn
		.query_row(
			"SELECT * FROM provider_instances WHERE id = ?1",
			params![id.to_string()],
			map_row,
		)
		.optional()?
		.ok_or_else(|| StorageError::NotFound(format!("provider {id}")))
}

pub fn insert(conn: &Connection, provider: &ProviderInstance) -> Result<(), StorageError> {
	conn
		.execute(
			"INSERT INTO provider_instances (
            id, adapter_id, display_name, base_url_override, credential_kind, credential_ref,
            enabled, proxy_mode, insecure_http_confirmed_at, models_synced_at,
            models_sync_status, models_sync_error_code, created_at, updated_at, sort_order
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
            (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM provider_instances))",
			params![
				provider.id.to_string(),
				provider.adapter_id,
				provider.display_name,
				provider.base_url_override,
				provider.credential_kind.as_str(),
				provider.credential_ref,
				provider.enabled as i64,
				provider.proxy_mode.as_str(),
				provider.insecure_http_confirmed_at,
				provider.models_synced_at,
				provider.models_sync_status.as_str(),
				provider.models_sync_error_code,
				provider.created_at,
				provider.updated_at,
			],
		)
		.map_err(|e| StorageError::from_sqlite_constraint(e, "provider"))?;
	Ok(())
}

pub fn update_configuration(conn: &Connection, provider: &ProviderInstance) -> Result<(), StorageError> {
	let changed = conn
		.execute(
			"UPDATE provider_instances SET
            adapter_id = ?2,
            display_name = ?3,
            base_url_override = ?4,
            credential_kind = ?5,
            credential_ref = ?6,
            enabled = ?7,
            proxy_mode = ?8,
            insecure_http_confirmed_at = ?9,
            models_synced_at = ?10,
            models_sync_status = ?11,
            models_sync_error_code = ?12,
            updated_at = ?13
         WHERE id = ?1",
			params![
				provider.id.to_string(),
				provider.adapter_id,
				provider.display_name,
				provider.base_url_override,
				provider.credential_kind.as_str(),
				provider.credential_ref,
				provider.enabled as i64,
				provider.proxy_mode.as_str(),
				provider.insecure_http_confirmed_at,
				provider.models_synced_at,
				provider.models_sync_status.as_str(),
				provider.models_sync_error_code,
				provider.updated_at,
			],
		)
		.map_err(|e| StorageError::from_sqlite_constraint(e, "provider"))?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {}", provider.id)));
	}
	Ok(())
}

/// Update Provider configuration fields without touching `credential_ref` or sync metadata.
#[allow(clippy::too_many_arguments)]
pub fn update_configuration_keep_credential(
	conn: &Connection,
	id: Uuid,
	adapter_id: &str,
	display_name: &str,
	base_url_override: Option<&str>,
	credential_kind: CredentialKind,
	enabled: bool,
	proxy_mode: ProxyMode,
	insecure_http_confirmed_at: Option<&str>,
	updated_at: &str,
) -> Result<(), StorageError> {
	let changed = conn
		.execute(
			"UPDATE provider_instances SET
            adapter_id = ?2,
            display_name = ?3,
            base_url_override = ?4,
            credential_kind = ?5,
            enabled = ?6,
            proxy_mode = ?7,
            insecure_http_confirmed_at = ?8,
            updated_at = ?9
         WHERE id = ?1",
			params![
				id.to_string(),
				adapter_id,
				display_name,
				base_url_override,
				credential_kind.as_str(),
				enabled as i64,
				proxy_mode.as_str(),
				insecure_http_confirmed_at,
				updated_at,
			],
		)
		.map_err(|e| StorageError::from_sqlite_constraint(e, "provider"))?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {id}")));
	}
	Ok(())
}

/// Update only sync failure fields; preserve `models_synced_at`.
pub fn update_sync_failure(
	conn: &Connection,
	id: Uuid,
	status: ModelsSyncStatus,
	error_code: Option<&str>,
	updated_at: &str,
) -> Result<(), StorageError> {
	let changed = conn.execute(
		"UPDATE provider_instances SET
            models_sync_status = ?2,
            models_sync_error_code = ?3,
            updated_at = ?4
         WHERE id = ?1",
		params![id.to_string(), status.as_str(), error_code, updated_at],
	)?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {id}")));
	}
	Ok(())
}

pub fn set_enabled(conn: &Connection, id: Uuid, enabled: bool, updated_at: &str) -> Result<(), StorageError> {
	let changed = conn.execute(
		"UPDATE provider_instances SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
		params![id.to_string(), enabled as i64, updated_at],
	)?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {id}")));
	}
	Ok(())
}

/// Compare-and-set credential reference; fails when the current ref differs.
pub fn compare_and_set_credential_ref(
	conn: &Connection,
	id: Uuid,
	expected_old_ref: Option<&str>,
	new_ref: Option<&str>,
	updated_at: &str,
) -> Result<(), StorageError> {
	let changed = match expected_old_ref {
		Some(old) => conn.execute(
			"UPDATE provider_instances SET credential_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND credential_ref = ?4",
			params![id.to_string(), new_ref, updated_at, old],
		)?,
		None => conn.execute(
			"UPDATE provider_instances SET credential_ref = ?2, updated_at = ?3
             WHERE id = ?1 AND credential_ref IS NULL",
			params![id.to_string(), new_ref, updated_at],
		)?,
	};
	if changed == 0 {
		return Err(StorageError::Conflict(
			"provider credential reference changed concurrently".into(),
		));
	}
	Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
	let changed = conn
		.execute("DELETE FROM provider_instances WHERE id = ?1", params![id.to_string()])
		.map_err(|e| StorageError::from_sqlite_constraint(e, "provider"))?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {id}")));
	}
	Ok(())
}

/// Persist a full channel order. Caller must run inside a transaction.
/// `ordered_ids` is the complete desired order (index = sort_order).
pub fn reorder(conn: &Connection, ordered_ids: &[Uuid]) -> Result<(), StorageError> {
	for (sort_order, id) in ordered_ids.iter().enumerate() {
		let changed = conn.execute(
			"UPDATE provider_instances SET sort_order = ?2 WHERE id = ?1",
			params![id.to_string(), sort_order as i64],
		)?;
		if changed == 0 {
			return Err(StorageError::NotFound(format!("provider {id}")));
		}
	}
	Ok(())
}

pub fn update_sync_status(
	conn: &Connection,
	id: Uuid,
	synced_at: Option<&str>,
	status: ModelsSyncStatus,
	error_code: Option<&str>,
	updated_at: &str,
) -> Result<(), StorageError> {
	let changed = conn.execute(
		"UPDATE provider_instances SET
            models_synced_at = ?2,
            models_sync_status = ?3,
            models_sync_error_code = ?4,
            updated_at = ?5
         WHERE id = ?1",
		params![id.to_string(), synced_at, status.as_str(), error_code, updated_at],
	)?;
	if changed == 0 {
		return Err(StorageError::NotFound(format!("provider {id}")));
	}
	Ok(())
}
