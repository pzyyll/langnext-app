// ABOUTME: SQLite connection lifecycle, PRAGMAs, integrity checks, and backups.
// ABOUTME: Opens a configured connection per operation; never shares Connection across async tasks.
use crate::consts::{BACKUP_DIRNAME, DB_FILENAME, MAX_BACKUP_SNAPSHOTS, SQLITE_BUSY_TIMEOUT_MS};
use crate::domain::time::now_filename_utc;
use crate::error::StorageError;
use crate::storage::migrations::{self, latest_version, read_user_version};
use crate::storage::unit_of_work::UnitOfWork;
use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::{Path, PathBuf};

/// Handle for the application SQLite database path.
#[derive(Debug, Clone)]
pub struct Database {
	path: PathBuf,
	app_data_dir: PathBuf,
}

impl Database {
	pub fn new(app_data_dir: impl Into<PathBuf>) -> Result<Self, StorageError> {
		let app_data_dir = app_data_dir.into();
		fs::create_dir_all(&app_data_dir)?;
		let path = app_data_dir.join(DB_FILENAME);
		Ok(Self { path, app_data_dir })
	}

	pub fn path(&self) -> &Path {
		&self.path
	}

	pub fn app_data_dir(&self) -> &Path {
		&self.app_data_dir
	}

	pub fn backup_dir(&self) -> PathBuf {
		self.app_data_dir.join(BACKUP_DIRNAME)
	}

	/// Probe, migrate if needed, and verify the database is ready for use.
	pub fn initialize(&self) -> Result<(), StorageError> {
		if self.path.exists() {
			self.probe_existing()?;
			let version = self.read_version_readonly()?;
			let target = latest_version();
			if version > target {
				return Err(StorageError::StorageVersionUnsupported(format!(
					"database version {version} is newer than application version {target}"
				)));
			}
			if version < target {
				self.backup_before_migration(version)?;
				let mut conn = self.open_writable()?;
				migrations::migrate(&mut conn)
					.map_err(|e| StorageError::StorageUnavailable(format!("migration failed: {e}")))?;
				self.rotate_backups()?;
			}
		} else {
			let mut conn = self.open_writable()?;
			migrations::migrate(&mut conn)?;
		}
		// Final integrity check on a runtime-configured connection.
		let conn = self.open_runtime()?;
		self.integrity_check(&conn)?;
		Ok(())
	}

	fn probe_existing(&self) -> Result<(), StorageError> {
		let conn = Connection::open_with_flags(
			&self.path,
			OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
		)
		.map_err(|e| StorageError::StorageUnavailable(format!("cannot open database: {e}")))?;
		self.integrity_check(&conn)?;
		let version = read_user_version(&conn)?;
		let target = latest_version();
		if version > target {
			return Err(StorageError::StorageVersionUnsupported(format!(
				"database version {version} is newer than application version {target}"
			)));
		}
		Ok(())
	}

	fn read_version_readonly(&self) -> Result<i32, StorageError> {
		let conn = Connection::open_with_flags(
			&self.path,
			OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
		)?;
		read_user_version(&conn)
	}

	fn open_writable(&self) -> Result<Connection, StorageError> {
		if let Some(parent) = self.path.parent() {
			fs::create_dir_all(parent)?;
		}
		let conn = Connection::open(&self.path)?;
		conn.busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS as u64))?;
		conn.execute_batch("PRAGMA foreign_keys = ON;")?;
		Ok(conn)
	}

	/// Open a connection configured for normal runtime use.
	pub fn open_runtime(&self) -> Result<Connection, StorageError> {
		let conn = self.open_writable()?;
		conn.pragma_update(None, "journal_mode", "WAL")?;
		conn.pragma_update(None, "synchronous", "NORMAL")?;
		conn.execute_batch("PRAGMA foreign_keys = ON;")?;
		conn.busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS as u64))?;
		Ok(conn)
	}

	pub fn integrity_check(&self, conn: &Connection) -> Result<(), StorageError> {
		let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
		if result != "ok" {
			return Err(StorageError::StorageUnavailable(format!(
				"database integrity check failed: {result}"
			)));
		}
		Ok(())
	}

	fn backup_before_migration(&self, old_version: i32) -> Result<(), StorageError> {
		let backup_dir = self.backup_dir();
		fs::create_dir_all(&backup_dir)?;
		let stamp = now_filename_utc();
		let final_name = format!("langnext-v{old_version}-{stamp}.sqlite3");
		let partial = backup_dir.join(format!("{final_name}.partial"));
		let dest = backup_dir.join(&final_name);

		let src = self.open_writable()?;
		self.integrity_check(&src)?;

		// Write to a partial path, verify, then atomically publish.
		if let Err(e) = (|| -> Result<(), StorageError> {
			{
				let mut dst = Connection::open(&partial)?;
				{
					let backup = rusqlite::backup::Backup::new(&src, &mut dst)
						.map_err(|e| StorageError::StorageUnavailable(format!("backup start failed: {e}")))?;
					backup
						.run_to_completion(100, std::time::Duration::from_millis(10), None)
						.map_err(|e| StorageError::StorageUnavailable(format!("backup copy failed: {e}")))?;
				}
				// Drop backup borrow before further work on dst.
				let _ = dst;
			}
			{
				let snap = Connection::open_with_flags(
					&partial,
					OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
				)?;
				self.integrity_check(&snap)?;
			}
			fs::rename(&partial, &dest)?;
			Ok(())
		})() {
			let _ = fs::remove_file(&partial);
			return Err(e);
		}
		Ok(())
	}

	/// Keep the three newest integrity-checked snapshots; quarantine corrupt candidates.
	pub fn rotate_backups(&self) -> Result<(), StorageError> {
		let backup_dir = self.backup_dir();
		if !backup_dir.exists() {
			return Ok(());
		}
		let mut valid: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
		for entry in fs::read_dir(&backup_dir)?.filter_map(|e| e.ok()) {
			let path = entry.path();
			let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
			// Only rotate published `.sqlite3` snapshots; ignore partial/invalid suffixes.
			if !name.ends_with(".sqlite3") || name.contains(".partial") || name.contains(".invalid") {
				continue;
			}
			// Integrity-check before considering the snapshot.
			let is_valid = match Connection::open_with_flags(
				&path,
				OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
			) {
				Ok(conn) => self.integrity_check(&conn).is_ok(),
				Err(_) => false,
			};
			if is_valid {
				let mtime = entry
					.metadata()
					.ok()
					.and_then(|m| m.modified().ok())
					.unwrap_or(std::time::SystemTime::UNIX_EPOCH);
				valid.push((path, mtime));
			} else {
				let invalid = path.with_file_name(format!("{name}.invalid"));
				let _ = fs::rename(&path, invalid);
			}
		}
		valid.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
		for (path, _) in valid.into_iter().skip(MAX_BACKUP_SNAPSHOTS) {
			fs::remove_file(&path)?;
		}
		Ok(())
	}

	pub fn read<T, F>(&self, f: F) -> Result<T, StorageError>
	where
		F: FnOnce(&Connection) -> Result<T, StorageError>,
	{
		let conn = self.open_runtime()?;
		f(&conn)
	}

	/// Aggregate read pinned to one deferred snapshot transaction.
	///
	/// All SELECTs inside the closure observe the same committed database state.
	/// The closure must not perform writes.
	pub fn read_snapshot<T, F>(&self, f: F) -> Result<T, StorageError>
	where
		F: FnOnce(&Connection) -> Result<T, StorageError>,
	{
		let mut conn = self.open_runtime()?;
		let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)?;
		let result = f(&tx);
		match result {
			Ok(value) => {
				tx.commit()?;
				Ok(value)
			}
			Err(e) => {
				let _ = tx.rollback();
				Err(e)
			}
		}
	}

	pub fn write<T, F>(&self, f: F) -> Result<T, StorageError>
	where
		F: FnOnce(&Connection) -> Result<T, StorageError>,
	{
		let conn = self.open_runtime()?;
		f(&conn)
	}

	pub fn transaction<T, F>(&self, f: F) -> Result<T, StorageError>
	where
		F: FnOnce(&UnitOfWork<'_>) -> Result<T, StorageError>,
	{
		let mut conn = self.open_runtime()?;
		let tx = conn.transaction()?;
		let uow = UnitOfWork::new(tx);
		match f(&uow) {
			Ok(value) => {
				uow.commit()?;
				Ok(value)
			}
			Err(e) => {
				let _ = uow.rollback();
				Err(e)
			}
		}
	}
}
