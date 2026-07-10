// ABOUTME: SQLite storage layer: database lifecycle, migrations, and unit of work.
// ABOUTME: All portable configuration is accessed only through this module and repositories.
pub mod database;
pub mod migrations;
pub mod unit_of_work;

pub use database::Database;

#[cfg(test)]
mod tests;
