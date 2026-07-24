# Credential Vault: Legacy UTF-16 Entry Decode

## Summary

**Target:** `feat/phase-1c-profile-runtime-ux`

**Conclusion:** Root cause found and fixed.

LLM Translate on this branch returned `network request failed`. Investigation showed the request never left the process: reqwest rejected the `Authorization` header at build time with `failed to parse header value`. The header value contained embedded NUL bytes (`0x00`) carried verbatim from a legacy OS keyring entry stored as UTF-16LE.

This is a pre-existing credential vault regression on `main`, not introduced by Phase 1C. Phase 1C left the provider HTTP and credential paths unchanged from `main`; the bug surfaced because the stored API key on the test profile pre-dates the storage rewrite.

## Symptom Trail

1. UI toast: `network request failed`.
2. Frontend maps IPC `validation_failed` with a `network` substring to `network`; the generic string hides the cause.
3. Rust `bounded_http::map_reqwest_error` folded every non-timeout reqwest error to the same opaque string.
4. Temporary diagnostics in `bounded_http.rs` (since reverted) logged the first/last bytes and non-printable count of each header value without leaking the secret:

   ```
   bounded_http_header_fingerprint name=Authorization len=109 all_ascii_printable=false
     first_byte=0x42 last_byte=0x00 non_printable_bytes=51 non_printable_hex=00 00 ... (x51)
   ```

5. `len=109` decomposes as `Bearer ` (7 bytes) plus a 102-byte key. 51 of those 102 bytes are `0x00` — exactly half, alternating with ASCII — the signature of UTF-16LE.

## Root Cause

`src-tauri/src/credentials/vault.rs::get_os_keyring` read OS keyring secrets through `entry.get_secret()` and decoded the raw bytes with `String::from_utf8`. Two facts interact badly on Windows:

- The earliest vault implementation (`3288867`, storage subsystem) wrote every credential with `entry.set_password`, which UTF-16-encodes on Windows. Those entries persist on disk.
- `String::from_utf8` accepts `0x00` as U+0000, so UTF-16LE bytes decode "successfully" into NUL-laced garbage instead of erroring.

The existing fallback to `entry.get_password()` (which correctly reverses UTF-16LE) only triggered when `get_secret()` returned `Err`. For legacy entries `get_secret()` succeeds and returns the raw UTF-16LE bytes, so the fallback never ran.

The result flowed into `provider_http.rs`:

```rust
headers.insert("Authorization".into(), format!("Bearer {secret}"));
```

producing `Bearer B\0a\0d\0k\0e\0y\0...`. reqwest rejects embedded NUL in a header value with a builder error before any network send, reported upstream as `network request failed`.

### History

- `3288867` — vault reads/writes via `set_password`/`get_password` (UTF-16 on Windows).
- `6f9b2f6` — storage loop closure switches to `set_secret`/`get_secret` for raw UTF-8 and adds the `get_secret` → `get_password` fallback, but only on `Err`.
- `a7e073a` — formatting pass only.
- `894b1f4` (Phase 1A) — adds encrypted overflow; keyring path unchanged.

`git diff main -- src-tauri/src/credentials/vault.rs` is formatting-only; the bug is on `main`.

## Fix

`src-tauri/src/credentials/vault.rs::get_os_keyring` now treats a `from_utf8` success that contains a NUL as a legacy UTF-16LE entry and re-reads through `get_password()`. Non-NUL `from_utf8` outputs keep the raw-UTF-8 fast path.

```rust
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
```

Scope: one function, no schema migration, no credential re-entry required. The temporary `bounded_http.rs` diagnostics (header fingerprinting, reqwest source chain logging) were reverted to keep this fix minimal.

## Validation

| Command                                              | Result                                     |
| ---------------------------------------------------- | ------------------------------------------ |
| `cargo check` (src-tauri)                            | Passed                                     |
| `cargo test --lib vault`                             | 8 passed, 2 ignored (interactive OS vault) |
| `cargo test --quiet --lib`                           | 306 passed, 2 ignored                      |
| `git diff -- src-tauri/src/services/bounded_http.rs` | Empty (diagnostics reverted)               |

The two ignored `vault` tests require a live OS credential store session and cannot exercise `get_os_keyring` without an injectable `keyring::Entry`. No unit test for the legacy decode path was added; a regression test would require either pinning `keyring::Entry` behind a trait or seeding a Windows Cred Manager entry written via `set_password`, both out of scope for this fix.

## Limitations and Follow-ups

- The fix is reactive: it tolerates legacy entries instead of migrating them. A future migration could re-encode any NUL-bearing entry to UTF-8 on first read and rewrite it via `set_secret`, eliminating the per-read NUL check. Low priority; the check is one `contains('\0')` on an already-decoded `String`.
- `map_reqwest_error` still collapses connect/builder/request errors to a single user-visible string. Future diagnostics work could preserve the reqwest error category (connect / builder / body / decode) through `StorageError` so the UI can distinguish "bad header" from "cannot reach host". Out of scope here; the Tauri/Rust error layer is unrelated to this credential decode bug.
- Phase 1C was not the cause and needed no change. The Phase 1C provider/HTTP/bounded_http path is byte-for-byte identical to `main`.

## File References

- Fix: `src-tauri/src/credentials/vault.rs` (`NativeCredentialVault::get_os_keyring`)
- Reader: `src-tauri/src/services/provider_http.rs` (`load_secret_for_scheme`, `inject_auth_headers_only`)
- Mapper: `src-tauri/src/services/bounded_http.rs` (`map_reqwest_error`)
