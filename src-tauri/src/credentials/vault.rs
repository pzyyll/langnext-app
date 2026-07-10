// ABOUTME: CredentialVault trait and native keyring implementation.
// ABOUTME: Secrets are never exposed through Tauri commands or Debug output.
use crate::consts::CREDENTIAL_SERVICE_NAME;
use crate::error::StorageError;

/// Private vault interface used only by application services.
pub trait CredentialVault: Send + Sync {
	fn set(&self, account: &str, secret: &str) -> Result<(), StorageError>;
	/// Retrieve a secret for backend HTTP use only. Never return to IPC.
	fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError>;
	fn delete(&self, account: &str) -> Result<(), StorageError>;
	fn exists(&self, account: &str) -> Result<bool, StorageError>;
}

/// Native OS credential store backed by the `keyring` crate.
pub struct NativeCredentialVault {
	service: String,
}

impl NativeCredentialVault {
	pub fn new() -> Self {
		Self {
			service: CREDENTIAL_SERVICE_NAME.to_string(),
		}
	}

	fn entry(&self, account: &str) -> Result<keyring::Entry, StorageError> {
		keyring::Entry::new(&self.service, account).map_err(|e| map_keyring_error(e))
	}
}

impl Default for NativeCredentialVault {
	fn default() -> Self {
		Self::new()
	}
}

impl CredentialVault for NativeCredentialVault {
	fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
		self.entry(account)?.set_password(secret).map_err(map_keyring_error)
	}

	fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError> {
		self.entry(account)?.get_password().map_err(map_keyring_error)
	}

	fn delete(&self, account: &str) -> Result<(), StorageError> {
		match self.entry(account)?.delete_credential() {
			Ok(()) => Ok(()),
			Err(keyring::Error::NoEntry) => Ok(()), // idempotent cleanup
			Err(e) => Err(map_keyring_error(e)),
		}
	}

	fn exists(&self, account: &str) -> Result<bool, StorageError> {
		match self.entry(account)?.get_password() {
			Ok(_) => Ok(true),
			Err(keyring::Error::NoEntry) => Ok(false),
			Err(e) => Err(map_keyring_error(e)),
		}
	}
}

fn map_keyring_error(err: keyring::Error) -> StorageError {
	match err {
		keyring::Error::NoEntry => StorageError::NotFound("credential entry".into()),
		// Platform store missing / locked / unavailable.
		other => {
			let msg = other.to_string().to_lowercase();
			if msg.contains("unavailable")
				|| msg.contains("no password")
				|| msg.contains("platform")
				|| msg.contains("secret service")
			{
				StorageError::CredentialUnavailable
			} else {
				StorageError::CredentialAccess
			}
		}
	}
}

/// In-memory vault used only under `cfg(test)`. Not a production mock mode.
#[cfg(test)]
pub struct MemoryCredentialVault {
	inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryCredentialVault {
	pub fn new() -> Self {
		Self {
			inner: std::sync::Mutex::new(std::collections::HashMap::new()),
		}
	}
}

#[cfg(test)]
impl Default for MemoryCredentialVault {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
impl CredentialVault for MemoryCredentialVault {
	fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
		self
			.inner
			.lock()
			.expect("vault lock")
			.insert(account.to_string(), secret.to_string());
		Ok(())
	}

	fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError> {
		self
			.inner
			.lock()
			.expect("vault lock")
			.get(account)
			.cloned()
			.ok_or_else(|| StorageError::NotFound("credential entry".into()))
	}

	fn delete(&self, account: &str) -> Result<(), StorageError> {
		self.inner.lock().expect("vault lock").remove(account);
		Ok(())
	}

	fn exists(&self, account: &str) -> Result<bool, StorageError> {
		Ok(self.inner.lock().expect("vault lock").contains_key(account))
	}
}

/// Configurable failing vault for injected set/delete/read failures in tests.
#[cfg(test)]
#[derive(Default)]
pub struct FailingCredentialVault {
	inner: MemoryCredentialVault,
	fail_set: std::sync::Mutex<bool>,
	fail_delete: std::sync::Mutex<bool>,
	fail_get: std::sync::Mutex<bool>,
	fail_exists: std::sync::Mutex<bool>,
	error_kind: std::sync::Mutex<VaultFailKind>,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VaultFailKind {
	#[default]
	Unavailable,
	Access,
}

#[cfg(test)]
impl FailingCredentialVault {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn set_fail_set(&self, fail: bool) {
		*self.fail_set.lock().expect("lock") = fail;
	}

	pub fn set_fail_delete(&self, fail: bool) {
		*self.fail_delete.lock().expect("lock") = fail;
	}

	pub fn set_fail_get(&self, fail: bool) {
		*self.fail_get.lock().expect("lock") = fail;
	}

	pub fn set_fail_exists(&self, fail: bool) {
		*self.fail_exists.lock().expect("lock") = fail;
	}

	pub fn set_error_kind(&self, kind: VaultFailKind) {
		*self.error_kind.lock().expect("lock") = kind;
	}

	fn err(&self) -> StorageError {
		match *self.error_kind.lock().expect("lock") {
			VaultFailKind::Unavailable => StorageError::CredentialUnavailable,
			VaultFailKind::Access => StorageError::CredentialAccess,
		}
	}

	pub fn memory(&self) -> &MemoryCredentialVault {
		&self.inner
	}
}

#[cfg(test)]
impl CredentialVault for FailingCredentialVault {
	fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
		if *self.fail_set.lock().expect("lock") {
			return Err(self.err());
		}
		self.inner.set(account, secret)
	}

	fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError> {
		if *self.fail_get.lock().expect("lock") {
			return Err(self.err());
		}
		self.inner.get_for_backend_use(account)
	}

	fn delete(&self, account: &str) -> Result<(), StorageError> {
		if *self.fail_delete.lock().expect("lock") {
			return Err(self.err());
		}
		self.inner.delete(account)
	}

	fn exists(&self, account: &str) -> Result<bool, StorageError> {
		if *self.fail_exists.lock().expect("lock") {
			return Err(self.err());
		}
		self.inner.exists(account)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn memory_vault_round_trip() {
		let vault = MemoryCredentialVault::new();
		vault.set("a", "secret").unwrap();
		assert!(vault.exists("a").unwrap());
		assert_eq!(vault.get_for_backend_use("a").unwrap(), "secret");
		vault.delete("a").unwrap();
		assert!(!vault.exists("a").unwrap());
		vault.delete("a").unwrap(); // idempotent
	}

	/// RAII guard that deletes a disposable native vault account even when assertions fail.
	struct NativeVaultGuard {
		vault: NativeCredentialVault,
		account: String,
	}

	impl Drop for NativeVaultGuard {
		fn drop(&mut self) {
			let _ = self.vault.delete(&self.account);
		}
	}

	#[test]
	#[ignore = "requires interactive OS credential store session"]
	fn native_vault_smoke() {
		let vault = NativeCredentialVault::new();
		let account = format!("test/smoke/{}", uuid::Uuid::now_v7());
		let guard = NativeVaultGuard {
			vault: NativeCredentialVault::new(),
			account: account.clone(),
		};
		vault.set(&account, "disposable-secret").expect("set native credential");
		let value = vault.get_for_backend_use(&account).expect("read native credential");
		assert_eq!(value, "disposable-secret");
		vault.delete(&account).expect("delete native credential");
		// Guard also deletes on drop if the assertion above failed mid-test.
		drop(guard);
	}
}
