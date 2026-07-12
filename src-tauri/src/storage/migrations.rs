// ABOUTME: Ordered embedded SQL migration runner using PRAGMA user_version.
// ABOUTME: Migrations apply inside one transaction; SQL must stay transaction-compatible.
use crate::error::StorageError;
use rusqlite::Connection;

/// Embedded migrations in application order. Index 0 is version 1.
pub const MIGRATIONS: &[&str] = &[
	include_str!("../../migrations/0001_initial.sql"),
	include_str!("../../migrations/0002_provider_sort_order.sql"),
	include_str!("../../migrations/0003_profile_languages.sql"),
	include_str!("../../migrations/0004_model_adapter_id.sql"),
];

pub fn latest_version() -> i32 {
	MIGRATIONS.len() as i32
}

pub fn read_user_version(conn: &Connection) -> Result<i32, StorageError> {
	conn
		.query_row("PRAGMA user_version", [], |row| row.get(0))
		.map_err(StorageError::from)
}

pub fn set_user_version(conn: &Connection, version: i32) -> Result<(), StorageError> {
	conn
		.execute_batch(&format!("PRAGMA user_version = {version}"))
		.map_err(StorageError::from)
}

/// Apply all pending migrations inside the current connection (caller owns transaction).
pub fn apply_pending(conn: &Connection, from_version: i32) -> Result<(), StorageError> {
	apply_pending_with(conn, from_version, MIGRATIONS)
}

/// Apply migrations from an explicit ordered slice (production or test injection).
pub fn apply_pending_with(conn: &Connection, from_version: i32, migrations: &[&str]) -> Result<(), StorageError> {
	let target = migrations.len() as i32;
	if from_version > target {
		return Err(StorageError::StorageVersionUnsupported(format!(
			"database version {from_version} is newer than application version {target}"
		)));
	}
	if from_version == target {
		return Ok(());
	}

	for (index, sql) in migrations.iter().enumerate() {
		let version = (index + 1) as i32;
		if version <= from_version {
			continue;
		}
		conn
			.execute_batch(sql)
			.map_err(|e| StorageError::Migration(format!("migration {version} failed: {e}")))?;
		set_user_version(conn, version)?;
	}
	Ok(())
}

/// Run migrations in a single transaction on a writable connection.
pub fn migrate(conn: &mut Connection) -> Result<i32, StorageError> {
	migrate_with(conn, MIGRATIONS)
}

/// Run an explicit migration slice in one transaction (test injection for failure paths).
pub fn migrate_with(conn: &mut Connection, migrations: &[&str]) -> Result<i32, StorageError> {
	let from = read_user_version(conn)?;
	let target = migrations.len() as i32;
	if from > target {
		return Err(StorageError::StorageVersionUnsupported(format!(
			"database version {from} is newer than application version {target}"
		)));
	}
	if from == target {
		return Ok(from);
	}

	let tx = conn
		.transaction()
		.map_err(|e| StorageError::Migration(format!("begin migration transaction: {e}")))?;
	apply_pending_with(&tx, from, migrations)?;
	tx.commit()
		.map_err(|e| StorageError::Migration(format!("commit migration: {e}")))?;
	Ok(target)
}

#[cfg(test)]
mod tests {
	use super::*;
	use rusqlite::{Connection, OptionalExtension};

	#[test]
	fn migrate_empty_database_to_latest() {
		let mut conn = Connection::open_in_memory().unwrap();
		let version = migrate(&mut conn).unwrap();
		assert_eq!(version, latest_version());
		assert_eq!(read_user_version(&conn).unwrap(), latest_version());
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM app_settings", [], |r| r.get(0))
			.unwrap();
		assert_eq!(count, 1);
		// v3 columns exist for profile language prefs.
		let _: Option<String> = conn
			.query_row("SELECT source_lang FROM translation_profiles LIMIT 1", [], |r| r.get(0))
			.optional()
			.unwrap();
		// v4 optional per-model API Type override.
		let _: Option<String> = conn
			.query_row("SELECT adapter_id FROM provider_models LIMIT 1", [], |r| r.get(0))
			.optional()
			.unwrap();
	}

	#[test]
	fn migrate_is_idempotent() {
		let mut conn = Connection::open_in_memory().unwrap();
		migrate(&mut conn).unwrap();
		migrate(&mut conn).unwrap();
		assert_eq!(read_user_version(&conn).unwrap(), latest_version());
	}
}
