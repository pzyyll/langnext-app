// ABOUTME: CredentialVault trait and hybrid native keyring + encrypted file overflow.
// ABOUTME: Secrets are never exposed through Tauri commands or Debug output.
use crate::consts::CREDENTIAL_SERVICE_NAME;
use crate::error::StorageError;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// Windows `CRED_MAX_CREDENTIAL_BLOB_SIZE` (bytes). Portable threshold for OS vault bodies.
///
/// `set_password` on Windows UTF-16-encodes first (effective ~1280 chars). We store raw UTF-8
/// via `set_secret` so short API keys and medium blobs fit; larger secrets use file overflow.
const OS_KEYRING_SECRET_MAX_BYTES: usize = 2560;

/// Keyring account holding the 32-byte AES key that seals overflow files.
const FILE_VAULT_MASTER_ACCOUNT: &str = "__langnext_file_vault_master_v1";

/// Overflow file magic + version.
const FILE_VAULT_MAGIC: &[u8; 4] = b"LNV1";
const AES_GCM_NONCE_LEN: usize = 12;
const AES_GCM_KEY_LEN: usize = 32;

/// Private vault interface used only by application services.
pub trait CredentialVault: Send + Sync {
  fn set(&self, account: &str, secret: &str) -> Result<(), StorageError>;
  /// Retrieve a secret for backend HTTP use only. Never return to IPC.
  fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError>;
  fn delete(&self, account: &str) -> Result<(), StorageError>;
  fn exists(&self, account: &str) -> Result<bool, StorageError>;
}

/// Native OS credential store with encrypted file overflow for large secrets.
///
/// Models/API keys stay in the OS keyring. Google service-account JSON typically exceeds the
/// Windows Credential Manager blob limit and is sealed under `overflow_dir` with a master key
/// kept in the OS keyring.
pub struct NativeCredentialVault {
  service: String,
  overflow_dir: PathBuf,
}

impl NativeCredentialVault {
  pub fn new(overflow_dir: PathBuf) -> Self {
    Self {
      service: CREDENTIAL_SERVICE_NAME.to_string(),
      overflow_dir,
    }
  }

  fn entry(&self, account: &str) -> Result<keyring::Entry, StorageError> {
    keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
  }

  fn overflow_path(&self, account: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(account.as_bytes());
    let digest = hasher.finalize();
    let name = hex_encode(&digest);
    self.overflow_dir.join(format!("{name}.bin"))
  }

  fn ensure_overflow_dir(&self) -> Result<(), StorageError> {
    fs::create_dir_all(&self.overflow_dir)
      .map_err(|e| StorageError::StorageUnavailable(format!("credential overflow directory unavailable: {e}")))
  }

  fn master_key(&self) -> Result<[u8; AES_GCM_KEY_LEN], StorageError> {
    let entry = self.entry(FILE_VAULT_MASTER_ACCOUNT)?;
    match entry.get_secret() {
      Ok(bytes) if bytes.len() == AES_GCM_KEY_LEN => {
        let mut key = [0u8; AES_GCM_KEY_LEN];
        key.copy_from_slice(&bytes);
        Ok(key)
      }
      Ok(_) => {
        // Corrupt/unexpected length — rotate.
        let key = generate_master_key();
        entry.set_secret(&key).map_err(map_keyring_error)?;
        Ok(key)
      }
      Err(keyring::Error::NoEntry) => {
        let key = generate_master_key();
        entry.set_secret(&key).map_err(map_keyring_error)?;
        Ok(key)
      }
      Err(e) => {
        // Legacy installs may have stored the master as a password string.
        match entry.get_password() {
          Ok(text) => {
            let decoded = hex_decode(text.trim()).ok_or(StorageError::CredentialAccess)?;
            if decoded.len() != AES_GCM_KEY_LEN {
              return Err(StorageError::CredentialAccess);
            }
            let mut key = [0u8; AES_GCM_KEY_LEN];
            key.copy_from_slice(&decoded);
            Ok(key)
          }
          Err(_) => Err(map_keyring_error(e)),
        }
      }
    }
  }

  fn write_overflow(&self, account: &str, secret: &str) -> Result<(), StorageError> {
    self.ensure_overflow_dir()?;
    let key = self.master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| StorageError::Internal("aes key".into()))?;
    let mut nonce_bytes = [0u8; AES_GCM_NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
      .encrypt(nonce, secret.as_bytes())
      .map_err(|_| StorageError::CredentialAccess)?;

    let mut blob = Vec::with_capacity(FILE_VAULT_MAGIC.len() + AES_GCM_NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(FILE_VAULT_MAGIC);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);

    let path = self.overflow_path(account);
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, &blob).map_err(|e| StorageError::StorageUnavailable(format!("credential overflow write: {e}")))?;
    fs::rename(&tmp, &path)
      .map_err(|e| StorageError::StorageUnavailable(format!("credential overflow commit: {e}")))?;
    Ok(())
  }

  fn read_overflow(&self, account: &str) -> Result<Option<String>, StorageError> {
    let path = self.overflow_path(account);
    if !path.exists() {
      return Ok(None);
    }
    let blob =
      fs::read(&path).map_err(|e| StorageError::StorageUnavailable(format!("credential overflow read: {e}")))?;
    if blob.len() < FILE_VAULT_MAGIC.len() + AES_GCM_NONCE_LEN + 1 {
      return Err(StorageError::CredentialAccess);
    }
    if &blob[..FILE_VAULT_MAGIC.len()] != FILE_VAULT_MAGIC {
      return Err(StorageError::CredentialAccess);
    }
    let nonce_start = FILE_VAULT_MAGIC.len();
    let nonce_end = nonce_start + AES_GCM_NONCE_LEN;
    let nonce = Nonce::from_slice(&blob[nonce_start..nonce_end]);
    let ciphertext = &blob[nonce_end..];
    let key = self.master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| StorageError::Internal("aes key".into()))?;
    let plain = cipher
      .decrypt(nonce, ciphertext)
      .map_err(|_| StorageError::CredentialAccess)?;
    String::from_utf8(plain)
      .map(Some)
      .map_err(|_| StorageError::CredentialAccess)
  }

  fn delete_overflow(&self, account: &str) -> Result<(), StorageError> {
    let path = self.overflow_path(account);
    match fs::remove_file(&path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(StorageError::StorageUnavailable(format!(
        "credential overflow delete: {e}"
      ))),
    }
  }

  fn set_os_keyring(&self, account: &str, secret: &str) -> Result<(), StorageError> {
    let entry = self.entry(account)?;
    // Prefer raw bytes: Windows set_password UTF-16-encodes and halves capacity.
    entry.set_secret(secret.as_bytes()).map_err(map_keyring_error)
  }

  fn get_os_keyring(&self, account: &str) -> Result<String, StorageError> {
    let entry = self.entry(account)?;
    match entry.get_secret() {
      Ok(bytes) => match String::from_utf8(bytes) {
        // New entries are stored as raw UTF-8 via set_secret.
        Ok(text) if !text.contains('\0') => Ok(text),
        // Legacy entries were written via set_password, which UTF-16-encodes on Windows.
        // get_secret returns those raw UTF-16LE bytes; from_utf8 "succeeds" because NUL
        // (U+0000) is valid UTF-8, producing NUL-laced garbage that breaks header parsing.
        // Re-read via get_password, which decodes UTF-16LE back to the original secret.
        _ => match entry.get_password() {
          Ok(text) => Ok(text),
          Err(keyring::Error::NoEntry) => Err(StorageError::NotFound("credential entry".into())),
          Err(e) => Err(map_keyring_error(e)),
        },
      },
      Err(keyring::Error::NoEntry) => Err(StorageError::NotFound("credential entry".into())),
      Err(secret_err) => {
        // Backward compatible with secrets written via set_password.
        match entry.get_password() {
          Ok(text) => Ok(text),
          Err(keyring::Error::NoEntry) => Err(StorageError::NotFound("credential entry".into())),
          Err(_) => Err(map_keyring_error(secret_err)),
        }
      }
    }
  }

  fn delete_os_keyring(&self, account: &str) -> Result<(), StorageError> {
    match self.entry(account)?.delete_credential() {
      Ok(()) => Ok(()),
      Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(map_keyring_error(e)),
    }
  }

  fn os_keyring_exists(&self, account: &str) -> Result<bool, StorageError> {
    let entry = self.entry(account)?;
    match entry.get_secret() {
      Ok(_) => Ok(true),
      Err(keyring::Error::NoEntry) => match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(map_keyring_error(e)),
      },
      Err(e) => match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Err(map_keyring_error(e)),
        Err(e2) => Err(map_keyring_error(e2)),
      },
    }
  }
}

impl CredentialVault for NativeCredentialVault {
  fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
    let bytes = secret.as_bytes();
    if bytes.len() <= OS_KEYRING_SECRET_MAX_BYTES {
      match self.set_os_keyring(account, secret) {
        Ok(()) => {
          // Prefer a single location; drop any previous overflow blob.
          let _ = self.delete_overflow(account);
          return Ok(());
        }
        Err(StorageError::Validation(_)) | Err(StorageError::CredentialAccess) => {
          // Size/platform rejection — fall through to overflow.
        }
        Err(e) => return Err(e),
      }
    }

    self.write_overflow(account, secret)?;
    // Avoid dual-read of a stale short keyring value.
    let _ = self.delete_os_keyring(account);
    Ok(())
  }

  fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError> {
    if let Some(secret) = self.read_overflow(account)? {
      return Ok(secret);
    }
    self.get_os_keyring(account)
  }

  fn delete(&self, account: &str) -> Result<(), StorageError> {
    let overflow = self.delete_overflow(account);
    let keyring = self.delete_os_keyring(account);
    overflow.and(keyring)
  }

  fn exists(&self, account: &str) -> Result<bool, StorageError> {
    if self.overflow_path(account).exists() {
      return Ok(true);
    }
    self.os_keyring_exists(account)
  }
}

fn generate_master_key() -> [u8; AES_GCM_KEY_LEN] {
  let mut key = [0u8; AES_GCM_KEY_LEN];
  rand::thread_rng().fill_bytes(&mut key);
  key
}

fn hex_encode(bytes: &[u8]) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for b in bytes {
    out.push(HEX[(b >> 4) as usize] as char);
    out.push(HEX[(b & 0xf) as usize] as char);
  }
  out
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
  if text.len() % 2 != 0 {
    return None;
  }
  let mut out = Vec::with_capacity(text.len() / 2);
  let bytes = text.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let hi = hex_nibble(bytes[i])?;
    let lo = hex_nibble(bytes[i + 1])?;
    out.push((hi << 4) | lo);
    i += 2;
  }
  Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(b - b'a' + 10),
    b'A'..=b'F' => Some(b - b'A' + 10),
    _ => None,
  }
}

fn map_keyring_error(err: keyring::Error) -> StorageError {
  match err {
    keyring::Error::NoEntry => StorageError::NotFound("credential entry".into()),
    keyring::Error::TooLong(what, max) => StorageError::Validation(format!(
      "credential field `{what}` exceeds OS vault limit ({max} bytes)"
    )),
    keyring::Error::NoStorageAccess(_) => StorageError::CredentialUnavailable,
    keyring::Error::PlatformFailure(inner) => {
      let msg = inner.to_string().to_lowercase();
      if msg.contains("unavailable")
        || msg.contains("no such logon session")
        || msg.contains("locked")
        || msg.contains("secret service")
      {
        StorageError::CredentialUnavailable
      } else {
        StorageError::CredentialAccess
      }
    }
    keyring::Error::Invalid(_, _) => StorageError::CredentialAccess,
    keyring::Error::NotSupportedByStore(_) => StorageError::CredentialAccess,
    other => {
      let msg = other.to_string().to_lowercase();
      if msg.contains("unavailable") || msg.contains("no storage access") || msg.contains("secret service") {
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

  pub fn len(&self) -> usize {
    self.inner.lock().expect("vault lock").len()
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

  #[test]
  fn hex_round_trip() {
    let bytes = [0u8, 1, 15, 16, 255];
    let encoded = hex_encode(&bytes);
    assert_eq!(encoded, "00010f10ff");
    assert_eq!(hex_decode(&encoded).unwrap(), bytes);
  }

  #[test]
  fn overflow_path_is_stable_and_non_secret() {
    let dir = PathBuf::from("/tmp/vault-test");
    let vault = NativeCredentialVault::new(dir);
    let a = vault.overflow_path("integration/abc/service-account-json/op");
    let b = vault.overflow_path("integration/abc/service-account-json/op");
    assert_eq!(a, b);
    let name = a.file_name().unwrap().to_string_lossy();
    assert!(!name.contains("integration"));
    assert!(!name.contains("service-account"));
  }

  #[test]
  fn map_keyring_too_long_is_not_unavailable() {
    let err = map_keyring_error(keyring::Error::TooLong("password encoded as UTF-16".into(), 2560));
    assert!(matches!(err, StorageError::Validation(_)));
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
    let dir = tempfile::tempdir().unwrap();
    let vault = NativeCredentialVault::new(dir.path().join("overflow"));
    let account = format!("test/smoke/{}", uuid::Uuid::now_v7());
    let guard = NativeVaultGuard {
      vault: NativeCredentialVault::new(dir.path().join("overflow")),
      account: account.clone(),
    };
    vault.set(&account, "disposable-secret").expect("set native credential");
    let value = vault.get_for_backend_use(&account).expect("read native credential");
    assert_eq!(value, "disposable-secret");
    vault.delete(&account).expect("delete native credential");
    drop(guard);
  }

  #[test]
  #[ignore = "requires interactive OS credential store session"]
  fn native_vault_large_secret_overflow() {
    let dir = tempfile::tempdir().unwrap();
    let vault = NativeCredentialVault::new(dir.path().join("overflow"));
    let account = format!("test/large/{}", uuid::Uuid::now_v7());
    let guard = NativeVaultGuard {
      vault: NativeCredentialVault::new(dir.path().join("overflow")),
      account: account.clone(),
    };
    // Larger than Windows CredWrite blob limit so the hybrid path must use overflow files.
    let large = "A".repeat(OS_KEYRING_SECRET_MAX_BYTES + 512);
    vault.set(&account, &large).expect("set large credential");
    assert!(vault.overflow_path(&account).exists());
    let value = vault.get_for_backend_use(&account).expect("read large credential");
    assert_eq!(value, large);
    vault.delete(&account).expect("delete large credential");
    assert!(!vault.overflow_path(&account).exists());
    drop(guard);
  }
}
