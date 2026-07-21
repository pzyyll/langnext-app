// ABOUTME: Credential vault integration and opaque reference helpers.
// ABOUTME: Only application services may read secrets for backend use.
pub mod coordinator;
pub mod refs;
pub mod vault;

pub use refs::{global_proxy_ref, ocr_api_key_ref, ocr_secret_key_ref, provider_ref};
pub use vault::{CredentialVault, NativeCredentialVault};

#[cfg(test)]
pub use vault::{FailingCredentialVault, MemoryCredentialVault};

#[cfg(test)]
mod tests;
