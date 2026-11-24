//! Shared SQLite storage for native app features.

use std::path::Path;

use nsh_core::prelude::{blocking, data_dir};
use rusqlite::{Connection, TransactionBehavior};

const DATABASE_FILE: &str = "langnext.sqlite3";
const USER_VERSION_PRAGMA: &str = "user_version";
const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_translation_history.sql")];

/// Runs a database operation on a blocking worker with an up-to-date schema.
pub(crate) async fn run<T: Send + 'static>(
    operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String> {
    let directory = data_dir().ok_or("The app data directory is unavailable.")?;
    blocking(move || {
        let mut db = open_at(&directory)?;
        operation(&mut db).map_err(|_| "Could not query the app database.".to_owned())
    })
    .await
    .map_err(|_| "The app database worker failed.".to_owned())?
}

pub(crate) fn open_at(directory: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(directory).map_err(|_| "Could not create the app data directory.")?;
    let mut db = Connection::open(directory.join(DATABASE_FILE))
        .map_err(|_| "Could not open the app database.")?;
    db.pragma_update(None, "foreign_keys", true)
        .map_err(|_| "Could not enable app database foreign keys.")?;
    migrate(&mut db, MIGRATIONS)?;
    Ok(db)
}

fn schema_version(db: &Connection) -> Result<usize, String> {
    let version: i32 = db
        .pragma_query_value(None, USER_VERSION_PRAGMA, |row| row.get(0))
        .map_err(|_| "Could not read the app database schema version.")?;
    usize::try_from(version).map_err(|_| "Invalid app database schema version.".to_owned())
}

fn unsupported_schema(found: usize, supported: usize) -> String {
    format!("App database schema version {found} is newer than supported version {supported}.")
}

fn migrate(db: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let version = schema_version(db)?;
    let supported = migrations.len();
    if version == supported {
        return Ok(());
    }
    if version > supported {
        return Err(unsupported_schema(version, supported));
    }

    let failure = |_| "Could not migrate the app database.".to_owned();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    // Another connection might have migrated the database while this one waited for the lock.
    let version = schema_version(&tx)?;
    let pending = migrations
        .get(version..)
        .ok_or_else(|| unsupported_schema(version, supported))?;
    for sql in pending {
        tx.execute_batch(sql).map_err(failure)?;
    }
    let new_version = i32::try_from(supported).map_err(|_| "Too many app database migrations.")?;
    tx.pragma_update(None, USER_VERSION_PRAGMA, new_version)
        .map_err(failure)?;
    tx.commit().map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATE_EXAMPLE: &str = "CREATE TABLE example (id INTEGER PRIMARY KEY);";
    const ADD_LABEL: &str = "ALTER TABLE example ADD COLUMN label TEXT NOT NULL DEFAULT 'saved';";

    #[test]
    fn applies_only_pending_migrations_and_keeps_existing_data() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db, &[CREATE_EXAMPLE]).unwrap();
        db.execute("INSERT INTO example (id) VALUES (1)", [])
            .unwrap();
        let migrations = [CREATE_EXAMPLE, ADD_LABEL];
        migrate(&mut db, &migrations).unwrap();
        migrate(&mut db, &migrations).unwrap();

        let label: String = db
            .query_row("SELECT label FROM example WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(label, "saved");
        assert_eq!(schema_version(&db).unwrap(), migrations.len());
    }

    #[test]
    fn rolls_back_schema_changes_if_a_pending_migration_fails() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db, &[CREATE_EXAMPLE]).unwrap();
        assert!(migrate(&mut db, &[CREATE_EXAMPLE, ADD_LABEL, "INVALID SQL"]).is_err());
        assert_eq!(schema_version(&db).unwrap(), 1);
        assert!(db.prepare("SELECT label FROM example").is_err());
        migrate(&mut db, &[CREATE_EXAMPLE, ADD_LABEL]).unwrap();
    }

    #[test]
    fn rejects_a_newer_schema_without_changing_it() {
        let mut db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, USER_VERSION_PRAGMA, 2).unwrap();
        assert!(migrate(&mut db, &[CREATE_EXAMPLE]).is_err());
        assert_eq!(schema_version(&db).unwrap(), 2);
        assert!(db.prepare("SELECT id FROM example").is_err());
    }
}
