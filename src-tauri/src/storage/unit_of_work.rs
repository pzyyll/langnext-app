// ABOUTME: Transaction-scoped repository access for multi-aggregate writes.
// ABOUTME: All repositories share one rusqlite Transaction; never hold over keyring I/O.
use rusqlite::Transaction;

/// Borrowed transaction handle passed to repositories during multi-step writes.
pub struct UnitOfWork<'conn> {
	tx: Transaction<'conn>,
}

impl<'conn> UnitOfWork<'conn> {
	pub fn new(tx: Transaction<'conn>) -> Self {
		Self { tx }
	}

	pub fn conn(&self) -> &Transaction<'conn> {
		&self.tx
	}

	pub fn commit(self) -> Result<(), rusqlite::Error> {
		self.tx.commit()
	}

	pub fn rollback(self) -> Result<(), rusqlite::Error> {
		self.tx.rollback()
	}
}
