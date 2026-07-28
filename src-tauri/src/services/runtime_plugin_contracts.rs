// ABOUTME: Runtime plugin manifest and archive-shape validation (Phase 0 contracts).
// ABOUTME: Validates IDs, paths, digests, bounds, references, host compatibility, and WIT ABI shape.
use crate::domain::runtime_plugin::{
  self, AUTH_POLICIES_MAX_COUNT, CAPABILITIES_MAX_COUNT, CREDENTIAL_SLOTS_MAX_COUNT, CapabilityDeclaration,
  CapabilityId, CapabilityIdError, CredentialSlotDecl, EndpointId, FILE_MAX_BYTES, FILES_MAX_COUNT, FileRole,
  HOST_PLUGIN_API_VERSION_MAJOR, HttpsOrigin, MANIFEST_FILE_PATH, MANIFEST_VERSION_V1, METHODS_MAX_COUNT,
  NETWORK_ENDPOINTS_MAX_COUNT, ORIGINS_MAX_COUNT, PACKAGE_TARGETS_MAX_COUNT, PAGES_MAX_COUNT, PageId,
  PermissionRequests, PluginApiVersion, PluginFileEntry, PluginId, PluginManifestV1, PublisherDeclaration,
  PublisherKeyFingerprint, PublisherKeyId, RuntimeDescriptor, SIGNATURE_FILE_PATH, SemVerVersion, UiDeclaration,
  check_file_index_collisions, host_package_target, package_targets_compatible, validate_archive_entry_path,
  validate_archive_path, validate_package_target_constraint, validate_slot_id_strict,
};
// Re-export PermissionRequests for ValidatedPluginManifest public API consumers.
use std::collections::HashMap;

/// Stable contract failure codes. Phase 3 distinguishes hard-reject codes from staging-only codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractErrorCode {
  UnknownManifestVersion,
  UnsupportedPluginApi,
  UnsupportedCapabilityMajor,
  InvalidField,
  DuplicateId,
  InvalidPath,
  InvalidDigest,
  UndeclaredReference,
  ReferenceMismatch,
  ArchiveMismatch,
  LimitExceeded,
  UnknownKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError {
  pub code: ContractErrorCode,
  pub message: String,
}

impl ContractError {
  fn new(code: ContractErrorCode, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for ContractError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{:?}: {}", self.code, self.message)
  }
}

impl std::error::Error for ContractError {}

/// One archive payload entry used for signed-payload-shape validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
  pub path: String,
  pub bytes: u64,
  pub sha256: String,
}

/// A plugin manifest that has passed `validate_manifest`. Field-private and constructible only
/// by `validate_manifest`, so checks that depend on a validated manifest (credential readiness,
/// schema cross-validation) cannot be bypassed with an unvalidated or partially-constructed
/// manifest. The required credential-slot set is derived from this validated context, never
/// from a caller-supplied slice that could be emptied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPluginManifest {
  manifest: PluginManifestV1,
}

impl ValidatedPluginManifest {
  /// The validated credential slot declarations. Required slots derived from this iterator
  /// cannot be deleted or emptied by a caller.
  pub fn credential_slots(&self) -> impl Iterator<Item = &CredentialSlotDecl> {
    self.manifest.credential_slots.iter()
  }

  /// The validated manifest's credential slot ids, for schema cross-validation.
  pub fn credential_slot_ids(&self) -> impl Iterator<Item = &str> {
    self.manifest.credential_slots.iter().map(|slot| slot.id.as_str())
  }

  /// Plugin id from the validated manifest.
  pub fn id(&self) -> &str {
    &self.manifest.id
  }

  /// Plugin version from the validated manifest.
  pub fn version(&self) -> &str {
    &self.manifest.version
  }

  /// Capability declarations from the validated manifest.
  pub fn capabilities(&self) -> &[CapabilityDeclaration] {
    &self.manifest.capabilities
  }

  /// Permission requests from the validated manifest (requests, not grants).
  pub fn permissions(&self) -> &PermissionRequests {
    &self.manifest.permissions
  }

  /// Runtime descriptor from the validated manifest.
  pub fn runtime(&self) -> &RuntimeDescriptor {
    &self.manifest.runtime
  }

  /// Signed file-index entries from the validated manifest.
  pub fn files(&self) -> &[PluginFileEntry] {
    &self.manifest.files
  }

  /// The underlying validated manifest reference (crate-private; for archive-shape checks).
  pub(crate) fn manifest(&self) -> &PluginManifestV1 {
    &self.manifest
  }
}

/// Deserialize a manifest with `deny_unknown_fields` and map serde errors to contract errors.
pub fn parse_manifest(json: &str) -> Result<PluginManifestV1, ContractError> {
  serde_json::from_str::<PluginManifestV1>(json).map_err(|err| {
    let msg = err.to_string();
    let code = if msg.contains("unknown field") {
      ContractErrorCode::UnknownKey
    } else {
      ContractErrorCode::InvalidField
    };
    ContractError::new(code, msg)
  })
}

/// Validate manifest structure, bounds, references, and host compatibility.
///
/// Signature verification is deferred to Phase 3; this validates only the signed payload
/// shape. Artifact rules are separated by runtime kind: bundled/frontend runtimes carry no
/// archive artifact; wasm/native runtimes must reference a `RuntimeArtifact` file entry.
pub fn validate_manifest(manifest: &PluginManifestV1) -> Result<ValidatedPluginManifest, ContractError> {
  if manifest.manifest_version != MANIFEST_VERSION_V1 {
    return Err(ContractError::new(
      ContractErrorCode::UnknownManifestVersion,
      format!(
        "unsupported manifest version {} (expected {MANIFEST_VERSION_V1})",
        manifest.manifest_version
      ),
    ));
  }

  let api = PluginApiVersion::parse(&manifest.plugin_api_version)
    .map_err(|e| ContractError::new(ContractErrorCode::InvalidField, format!("pluginApiVersion: {e}")))?;
  if !api.is_host_compatible() {
    return Err(ContractError::new(
      ContractErrorCode::UnsupportedPluginApi,
      format!(
        "plugin api version {} is incompatible with host major {HOST_PLUGIN_API_VERSION_MAJOR}",
        manifest.plugin_api_version
      ),
    ));
  }

  PluginId::parse(&manifest.id).map_err(|e| ContractError::new(ContractErrorCode::InvalidField, format!("id: {e}")))?;
  SemVerVersion::parse(&manifest.version)
    .map_err(|e| ContractError::new(ContractErrorCode::InvalidField, format!("version: {e}")))?;
  validate_publisher(&manifest.publisher)?;

  let file_index = build_file_index(&manifest.files)?;
  validate_runtime(&manifest.runtime, &file_index)?;
  validate_capabilities(&manifest.capabilities, &file_index)?;

  if let Some(config_schema) = &manifest.configuration_schema {
    require_file_role(
      &file_index,
      config_schema,
      FileRole::ConfigSchema,
      "configurationSchema",
    )?;
  }

  validate_credential_slots(&manifest.credential_slots)?;
  validate_permissions(&manifest.permissions)?;
  validate_ui(&manifest.ui, &file_index)?;
  validate_targets(&manifest.targets)?;

  Ok(ValidatedPluginManifest {
    manifest: manifest.clone(),
  })
}

/// Validate closed-set platform/architecture target constraints (shape only).
fn validate_targets(targets: &[crate::domain::runtime_plugin::PackageTargetConstraint]) -> Result<(), ContractError> {
  if targets.len() > PACKAGE_TARGETS_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!(
        "targets exceeds {PACKAGE_TARGETS_MAX_COUNT} entries (got {})",
        targets.len()
      ),
    ));
  }
  for (index, target) in targets.iter().enumerate() {
    validate_package_target_constraint(target)
      .map_err(|e| ContractError::new(ContractErrorCode::InvalidField, format!("targets[{index}]: {e}")))?;
  }
  Ok(())
}

/// Host target compatibility check used by package preview/install (fail closed).
pub fn validate_manifest_host_targets(manifest: &PluginManifestV1) -> Result<(), ContractError> {
  validate_targets(&manifest.targets)?;
  let host = host_package_target();
  if !package_targets_compatible(&manifest.targets, &host) {
    return Err(ContractError::new(
      ContractErrorCode::UnsupportedPluginApi,
      format!(
        "package targets do not include host {}/{}",
        host.platform, host.architecture
      ),
    ));
  }
  Ok(())
}

/// Validate that the archive payload matches the signed file index shape exactly.
///
/// The archive must contain `plugin.json`, `signatures/manifest.sig`, and every indexed
/// file, and nothing else. Reserved entries can never be indexed. Every indexed file's byte
/// length and SHA-256 digest must match the archive entry.
pub fn validate_archive_shape(manifest: &PluginManifestV1, entries: &[ArchiveEntry]) -> Result<(), ContractError> {
  validate_manifest(manifest)?;
  let mut archive: HashMap<String, &ArchiveEntry> = HashMap::new();
  let mut archive_paths = Vec::with_capacity(entries.len());
  for entry in entries {
    let normalized = validate_archive_entry_path(&entry.path).map_err(|e| {
      ContractError::new(
        ContractErrorCode::InvalidPath,
        format!("archive entry {}: {e}", entry.path),
      )
    })?;
    if archive.contains_key(&normalized) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate archive path: {normalized}"),
      ));
    }
    archive_paths.push(normalized.clone());
    archive.insert(normalized, entry);
  }
  check_file_index_collisions(&archive_paths)
    .map_err(|message| ContractError::new(ContractErrorCode::ArchiveMismatch, message))?;

  if !archive.contains_key(MANIFEST_FILE_PATH) {
    return Err(ContractError::new(
      ContractErrorCode::ArchiveMismatch,
      format!("archive is missing {MANIFEST_FILE_PATH}"),
    ));
  }
  if !archive.contains_key(SIGNATURE_FILE_PATH) {
    return Err(ContractError::new(
      ContractErrorCode::ArchiveMismatch,
      format!("archive is missing {SIGNATURE_FILE_PATH}"),
    ));
  }

  for file in &manifest.files {
    let entry = archive.get(&file.path).ok_or_else(|| {
      ContractError::new(
        ContractErrorCode::ArchiveMismatch,
        format!("indexed file {} is absent from the archive", file.path),
      )
    })?;
    if entry.bytes != file.bytes {
      return Err(ContractError::new(
        ContractErrorCode::ArchiveMismatch,
        format!(
          "file {} byte length mismatch (archive {}, index {})",
          file.path, entry.bytes, file.bytes
        ),
      ));
    }
    if entry.sha256 != file.sha256 {
      return Err(ContractError::new(
        ContractErrorCode::InvalidDigest,
        format!("file {} sha256 mismatch", file.path),
      ));
    }
  }

  let indexed: std::collections::HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
  for path in archive.keys() {
    if path == MANIFEST_FILE_PATH || path == SIGNATURE_FILE_PATH {
      continue;
    }
    if !indexed.contains(path.as_str()) {
      return Err(ContractError::new(
        ContractErrorCode::ArchiveMismatch,
        format!("archive entry {path} is not in the file index"),
      ));
    }
  }

  Ok(())
}

fn validate_publisher(publisher: &PublisherDeclaration) -> Result<(), ContractError> {
  PublisherKeyId::parse(&publisher.key_id)
    .map_err(|e| ContractError::new(ContractErrorCode::InvalidField, format!("publisher.keyId: {e}")))?;
  PublisherKeyFingerprint::parse(&publisher.key_fingerprint).map_err(|e| {
    ContractError::new(
      ContractErrorCode::InvalidField,
      format!("publisher.keyFingerprint: {e}"),
    )
  })?;
  Ok(())
}

fn validate_runtime(
  runtime: &RuntimeDescriptor,
  file_index: &HashMap<String, PluginFileEntry>,
) -> Result<(), ContractError> {
  if runtime.kind.requires_archive_artifact() {
    let artifact = runtime.artifact.as_ref().ok_or_else(|| {
      ContractError::new(
        ContractErrorCode::InvalidField,
        format!("runtime {:?} requires an artifact path", runtime.kind),
      )
    })?;
    let normalized = validate_archive_path(artifact)
      .map_err(|e| ContractError::new(ContractErrorCode::InvalidPath, format!("runtime.artifact: {e}")))?;
    let role = file_index.get(&normalized).map(|e| e.role).ok_or_else(|| {
      ContractError::new(
        ContractErrorCode::UndeclaredReference,
        format!("runtime artifact {normalized} is not in the file index"),
      )
    })?;
    if role != FileRole::RuntimeArtifact {
      return Err(ContractError::new(
        ContractErrorCode::ReferenceMismatch,
        format!("runtime artifact {normalized} must have role runtime-artifact"),
      ));
    }
  } else if runtime.artifact.is_some() {
    return Err(ContractError::new(
      ContractErrorCode::InvalidField,
      format!("runtime {:?} must not declare an archive artifact", runtime.kind),
    ));
  }
  Ok(())
}

fn build_file_index(files: &[PluginFileEntry]) -> Result<HashMap<String, PluginFileEntry>, ContractError> {
  if files.len() > FILES_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("files exceed {FILES_MAX_COUNT} entries"),
    ));
  }
  let mut index = HashMap::new();
  let mut paths = Vec::with_capacity(files.len());
  for file in files {
    let normalized = validate_archive_path(&file.path)
      .map_err(|e| ContractError::new(ContractErrorCode::InvalidPath, format!("file path: {e}")))?;
    if index.contains_key(&normalized) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate file path: {normalized}"),
      ));
    }
    if file.bytes == 0 {
      return Err(ContractError::new(
        ContractErrorCode::InvalidField,
        format!("file {normalized} has zero bytes"),
      ));
    }
    if file.bytes > FILE_MAX_BYTES {
      return Err(ContractError::new(
        ContractErrorCode::LimitExceeded,
        format!("file {normalized} exceeds {FILE_MAX_BYTES} bytes"),
      ));
    }
    if file.sha256.len() != runtime_plugin::SHA256_HEX_LEN
      || !file.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    {
      return Err(ContractError::new(
        ContractErrorCode::InvalidDigest,
        format!("file {normalized} has an invalid sha256 digest"),
      ));
    }
    paths.push(normalized.clone());
    index.insert(normalized, file.clone());
  }
  check_file_index_collisions(&paths).map_err(|message| ContractError::new(ContractErrorCode::InvalidPath, message))?;
  Ok(index)
}

fn validate_capabilities(
  capabilities: &[CapabilityDeclaration],
  file_index: &HashMap<String, PluginFileEntry>,
) -> Result<(), ContractError> {
  if capabilities.len() > CAPABILITIES_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("capabilities exceed {CAPABILITIES_MAX_COUNT} entries"),
    ));
  }
  let mut seen = std::collections::HashSet::new();
  for cap in capabilities {
    validate_capability_decl(&cap.id)?;
    if !seen.insert(cap.id.clone()) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate capability id: {}", cap.id),
      ));
    }
    if let Some(schema) = &cap.preferences_schema {
      require_file_role(file_index, schema, FileRole::PreferenceSchema, "preferencesSchema")?;
    }
  }
  Ok(())
}

/// Strict capability id validation: syntax (no trim), closed v1 name set, supported major.
/// A known name with an unsupported major is `UnsupportedCapabilityMajor` (staging-only);
/// an unknown name is `InvalidField` (hard reject).
fn validate_capability_decl(cap_id: &str) -> Result<(), ContractError> {
  match CapabilityId::parse(cap_id) {
    Ok(_) => Ok(()),
    Err(CapabilityIdError::UnsupportedMajor { .. }) => Err(ContractError::new(
      ContractErrorCode::UnsupportedCapabilityMajor,
      format!("capability {cap_id} major is not supported by this host"),
    )),
    Err(CapabilityIdError::InvalidSyntax(message)) => Err(ContractError::new(ContractErrorCode::InvalidField, message)),
    Err(CapabilityIdError::UnknownCapability) => Err(ContractError::new(
      ContractErrorCode::InvalidField,
      format!("capability {cap_id} is not a known v1 capability"),
    )),
  }
}

fn validate_credential_slots(slots: &[CredentialSlotDecl]) -> Result<(), ContractError> {
  if slots.len() > CREDENTIAL_SLOTS_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("credentialSlots exceed {CREDENTIAL_SLOTS_MAX_COUNT} entries"),
    ));
  }
  let mut seen = std::collections::HashSet::new();
  for slot in slots {
    validate_slot_id_strict(&slot.id, "credential slot id")
      .map_err(|e| ContractError::new(ContractErrorCode::InvalidField, e))?;
    if !seen.insert(slot.id.clone()) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate credential slot id: {}", slot.id),
      ));
    }
  }
  Ok(())
}

fn validate_permissions(permissions: &PermissionRequests) -> Result<(), ContractError> {
  if permissions.network.len() > NETWORK_ENDPOINTS_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("network endpoints exceed {NETWORK_ENDPOINTS_MAX_COUNT} entries"),
    ));
  }
  let mut endpoints = std::collections::HashSet::new();
  for endpoint in &permissions.network {
    EndpointId::parse(&endpoint.id).map_err(|message| ContractError::new(ContractErrorCode::InvalidField, message))?;
    if !endpoints.insert(endpoint.id.clone()) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate network endpoint id: {}", endpoint.id),
      ));
    }
    if endpoint.origins.is_empty() {
      return Err(ContractError::new(
        ContractErrorCode::InvalidField,
        format!("network endpoint {} must declare at least one origin", endpoint.id),
      ));
    }
    if endpoint.origins.len() > ORIGINS_MAX_COUNT {
      return Err(ContractError::new(
        ContractErrorCode::LimitExceeded,
        format!("network endpoint {} exceeds {ORIGINS_MAX_COUNT} origins", endpoint.id),
      ));
    }
    let mut origins = std::collections::HashSet::new();
    for origin in &endpoint.origins {
      HttpsOrigin::parse(origin).map_err(|message| ContractError::new(ContractErrorCode::InvalidField, message))?;
      if !origins.insert(origin) {
        return Err(ContractError::new(
          ContractErrorCode::DuplicateId,
          format!("network endpoint {} repeats origin {origin}", endpoint.id),
        ));
      }
    }
    if endpoint.methods.is_empty() {
      return Err(ContractError::new(
        ContractErrorCode::InvalidField,
        format!("network endpoint {} must declare at least one method", endpoint.id),
      ));
    }
    if endpoint.methods.len() > METHODS_MAX_COUNT {
      return Err(ContractError::new(
        ContractErrorCode::LimitExceeded,
        format!("network endpoint {} exceeds {METHODS_MAX_COUNT} methods", endpoint.id),
      ));
    }
    let mut methods = std::collections::HashSet::new();
    for method in &endpoint.methods {
      if !methods.insert(method) {
        return Err(ContractError::new(
          ContractErrorCode::DuplicateId,
          format!("network endpoint {} repeats method {method:?}", endpoint.id),
        ));
      }
    }
  }

  if permissions.auth_policies.len() > AUTH_POLICIES_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("authPolicies exceed {AUTH_POLICIES_MAX_COUNT} entries"),
    ));
  }
  let mut policies = std::collections::HashSet::new();
  for policy in &permissions.auth_policies {
    runtime_plugin::AuthPolicyId::parse(policy)
      .map_err(|message| ContractError::new(ContractErrorCode::InvalidField, message))?;
    if !policies.insert(policy.clone()) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate auth policy id: {policy}"),
      ));
    }
  }
  Ok(())
}

fn validate_ui(ui: &UiDeclaration, file_index: &HashMap<String, PluginFileEntry>) -> Result<(), ContractError> {
  if ui.pages.len() > PAGES_MAX_COUNT {
    return Err(ContractError::new(
      ContractErrorCode::LimitExceeded,
      format!("ui.pages exceed {PAGES_MAX_COUNT} entries"),
    ));
  }
  let mut seen = std::collections::HashSet::new();
  for page in &ui.pages {
    PageId::parse(&page.id).map_err(|message| ContractError::new(ContractErrorCode::InvalidField, message))?;
    if !seen.insert(page.id.clone()) {
      return Err(ContractError::new(
        ContractErrorCode::DuplicateId,
        format!("duplicate page id: {}", page.id),
      ));
    }
    require_file_role(file_index, &page.entry, FileRole::PageAsset, "page entry")?;
  }
  match ui.mode {
    runtime_plugin::UiMode::Schema => {
      if !ui.pages.is_empty() {
        return Err(ContractError::new(
          ContractErrorCode::InvalidField,
          "ui.pages must be empty when ui.mode is schema",
        ));
      }
    }
    runtime_plugin::UiMode::CustomPage => {
      if ui.pages.is_empty() {
        return Err(ContractError::new(
          ContractErrorCode::InvalidField,
          "ui.pages must be non-empty when ui.mode is custom-page",
        ));
      }
    }
  }
  Ok(())
}

fn require_file_role(
  file_index: &HashMap<String, PluginFileEntry>,
  path: &str,
  expected: FileRole,
  field: &str,
) -> Result<(), ContractError> {
  let normalized = validate_archive_path(path)
    .map_err(|e| ContractError::new(ContractErrorCode::InvalidPath, format!("{field}: {e}")))?;
  let entry = file_index.get(&normalized).ok_or_else(|| {
    ContractError::new(
      ContractErrorCode::UndeclaredReference,
      format!("{field} {normalized} is not in the file index"),
    )
  })?;
  if entry.role != expected {
    return Err(ContractError::new(
      ContractErrorCode::ReferenceMismatch,
      format!("{field} {normalized} must have role {:?}", expected),
    ));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_plugin::{
    CredentialSlotKindV1, FileRole, HttpMethod, NetworkEndpointRequest, PackageDigest, PluginFileEntry,
    PublisherDeclaration, RuntimeDescriptor, RuntimeKind, UiDeclaration, UiMode,
  };

  const VALID_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  fn file(path: &str, role: FileRole, bytes: u64) -> PluginFileEntry {
    PluginFileEntry {
      path: path.into(),
      role,
      bytes,
      sha256: VALID_SHA.into(),
    }
  }

  fn wasm_manifest() -> PluginManifestV1 {
    PluginManifestV1 {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: "com.example.translate".into(),
      version: "1.2.0".into(),
      publisher: PublisherDeclaration {
        key_id: "vendor.example".into(),
        key_fingerprint: VALID_SHA.into(),
      },
      runtime: RuntimeDescriptor {
        kind: RuntimeKind::WasmComponent,
        artifact: Some("artifacts/plugin.wasm".into()),
      },
      targets: vec![],
      files: vec![file("artifacts/plugin.wasm", FileRole::RuntimeArtifact, 1024)],
      capabilities: vec![CapabilityDeclaration {
        id: "translate.text@1".into(),
        preferences_schema: None,
      }],
      configuration_schema: None,
      config_schema_version: None,
      credential_slots: vec![],
      permissions: PermissionRequests {
        network: vec![],
        auth_policies: vec![],
      },
      ui: UiDeclaration {
        mode: UiMode::Schema,
        pages: vec![],
      },
    }
  }

  fn bundled_manifest() -> PluginManifestV1 {
    let mut m = wasm_manifest();
    m.runtime = RuntimeDescriptor {
      kind: RuntimeKind::BundledRust,
      artifact: None,
    };
    m.files = vec![];
    m
  }

  fn archive_for(manifest: &PluginManifestV1) -> Vec<ArchiveEntry> {
    let mut entries = vec![
      ArchiveEntry {
        path: MANIFEST_FILE_PATH.into(),
        bytes: 512,
        sha256: VALID_SHA.into(),
      },
      ArchiveEntry {
        path: SIGNATURE_FILE_PATH.into(),
        bytes: 64,
        sha256: VALID_SHA.into(),
      },
    ];
    for f in &manifest.files {
      entries.push(ArchiveEntry {
        path: f.path.clone(),
        bytes: f.bytes,
        sha256: f.sha256.clone(),
      });
    }
    entries
  }

  #[test]
  fn runtime_plugin_contracts_valid_wasm_manifest_passes() {
    let manifest = wasm_manifest();
    validate_manifest(&manifest).expect("valid wasm manifest passes");
    validate_archive_shape(&manifest, &archive_for(&manifest)).expect("valid archive passes");
  }

  #[test]
  fn runtime_plugin_contracts_bundled_manifest_has_no_artifact_rule() {
    let manifest = bundled_manifest();
    validate_manifest(&manifest).expect("bundled manifest validates without an artifact");
    // Bundled manifests are not backed by an archive; archive shape is not required.
    assert!(manifest.runtime.artifact.is_none());
    assert!(manifest.files.is_empty());
  }

  #[test]
  fn runtime_plugin_contracts_bundled_rejects_artifact() {
    let mut manifest = bundled_manifest();
    manifest.runtime.artifact = Some("artifacts/x.wasm".into());
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidField);
  }

  #[test]
  fn runtime_plugin_contracts_wasm_requires_artifact() {
    let mut manifest = wasm_manifest();
    manifest.runtime.artifact = None;
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidField);
  }

  #[test]
  fn runtime_plugin_contracts_round_trip_json() {
    let manifest = wasm_manifest();
    let json = serde_json::to_string(&manifest).unwrap();
    let parsed = parse_manifest(&json).expect("round-trip parses");
    validate_manifest(&parsed).expect("parsed manifest validates");
  }

  #[test]
  fn runtime_plugin_contracts_unknown_manifest_version_rejected() {
    let mut manifest = wasm_manifest();
    manifest.manifest_version = 2;
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UnknownManifestVersion);
  }

  #[test]
  fn runtime_plugin_contracts_incompatible_plugin_api_rejected() {
    let mut manifest = wasm_manifest();
    manifest.plugin_api_version = "2.0".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UnsupportedPluginApi);
  }

  #[test]
  fn runtime_plugin_contracts_future_plugin_api_minor_rejected() {
    let mut manifest = wasm_manifest();
    manifest.plugin_api_version = "1.1".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UnsupportedPluginApi);
  }

  #[test]
  fn runtime_plugin_contracts_unsupported_capability_major_rejected() {
    let mut manifest = wasm_manifest();
    manifest.capabilities[0].id = "translate.text@2".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UnsupportedCapabilityMajor);
  }

  #[test]
  fn runtime_plugin_contracts_unknown_capability_name_rejected() {
    let mut manifest = wasm_manifest();
    manifest.capabilities[0].id = "unknown.cap@1".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidField);
  }

  #[test]
  fn runtime_plugin_contracts_semver_prerelease_accepted_leading_zero_rejected() {
    let mut manifest = wasm_manifest();
    manifest.version = "1.0.0-beta.1+build.5".into();
    validate_manifest(&manifest).expect("prerelease/build semver accepted");
    manifest.version = "1.02.3".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidField);
  }

  #[test]
  fn runtime_plugin_contracts_bad_plugin_id_rejected() {
    let mut manifest = wasm_manifest();
    manifest.id = "Bad-Case".into();
    assert!(validate_manifest(&manifest).is_err());
  }

  #[test]
  fn runtime_plugin_contracts_duplicate_capability_rejected() {
    let mut manifest = wasm_manifest();
    manifest.capabilities.push(CapabilityDeclaration {
      id: "translate.text@1".into(),
      preferences_schema: None,
    });
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);
  }

  #[test]
  fn runtime_plugin_contracts_duplicate_file_path_rejected() {
    let mut manifest = wasm_manifest();
    manifest.files.push(file("artifacts/plugin.wasm", FileRole::Other, 10));
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);
  }

  #[test]
  fn runtime_plugin_contracts_reserved_indexed_path_rejected() {
    let mut manifest = wasm_manifest();
    manifest.files.push(file(MANIFEST_FILE_PATH, FileRole::Other, 10));
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidPath);
  }

  #[test]
  fn runtime_plugin_contracts_control_char_path_rejected() {
    let mut manifest = wasm_manifest();
    manifest.runtime.artifact = Some("artifacts/\tplugin.wasm".into());
    manifest
      .files
      .push(file("artifacts/\tplugin.wasm", FileRole::RuntimeArtifact, 10));
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidPath);
  }

  #[test]
  fn runtime_plugin_contracts_bad_digest_rejected() {
    let mut manifest = wasm_manifest();
    manifest.files[0].sha256 = "tooshort".into();
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidDigest);
  }

  #[test]
  fn runtime_plugin_contracts_undeclared_runtime_artifact_rejected() {
    let mut manifest = wasm_manifest();
    manifest.runtime.artifact = Some("artifacts/missing.wasm".into());
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UndeclaredReference);
  }

  #[test]
  fn runtime_plugin_contracts_role_mismatch_rejected() {
    let mut manifest = wasm_manifest();
    manifest.files[0].role = FileRole::Locale;
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ReferenceMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_duplicate_credential_slot_rejected() {
    let mut manifest = wasm_manifest();
    manifest.credential_slots.push(CredentialSlotDecl {
      id: "api-key".into(),
      kind: CredentialSlotKindV1::SecretText,
      required: true,
    });
    manifest.credential_slots.push(CredentialSlotDecl {
      id: "api-key".into(),
      kind: CredentialSlotKindV1::SecretText,
      required: true,
    });
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);
  }

  #[test]
  fn runtime_plugin_contracts_https_origin_rejects_userinfo_query_fragment_and_noncanonical() {
    let mut manifest = wasm_manifest();
    let bad_origins = [
      "http://api.example.com",
      "https://user:pass@api.example.com",
      "https://api.example.com?q=1",
      "https://api.example.com#frag",
      "https://api.example.com/",
      "https://api.example.com:443",
      "https://API.Example.COM",
      "https://api.example.com/path",
    ];
    for bad in bad_origins {
      manifest.permissions.network.clear();
      manifest.permissions.network.push(NetworkEndpointRequest {
        id: "translate-api".into(),
        origins: vec![bad.into()],
        methods: vec![HttpMethod::Post],
      });
      assert!(validate_manifest(&manifest).is_err(), "origin {bad} should be rejected");
    }
    // Canonical origins pass.
    manifest.permissions.network.clear();
    manifest.permissions.network.push(NetworkEndpointRequest {
      id: "translate-api".into(),
      origins: vec!["https://api.example.com".into(), "https://api.example.com:8443".into()],
      methods: vec![HttpMethod::Post],
    });
    validate_manifest(&manifest).expect("canonical origins pass");
  }

  #[test]
  fn runtime_plugin_contracts_duplicate_network_endpoint_rejected() {
    let mut manifest = wasm_manifest();
    let endpoint = NetworkEndpointRequest {
      id: "translate-api".into(),
      origins: vec!["https://api.example.com".into()],
      methods: vec![HttpMethod::Post],
    };
    manifest.permissions.network.push(endpoint.clone());
    manifest.permissions.network.push(endpoint);
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);
  }

  #[test]
  fn runtime_plugin_contracts_custom_pages_list_validated() {
    let mut manifest = wasm_manifest();
    manifest.ui = UiDeclaration {
      mode: UiMode::CustomPage,
      pages: vec![runtime_plugin::PageDeclaration {
        id: "auth-page".into(),
        entry: "ui/index.html".into(),
      }],
    };
    // Entry not indexed -> UndeclaredReference.
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UndeclaredReference);

    manifest.files.push(file("ui/index.html", FileRole::PageAsset, 256));
    validate_manifest(&manifest).expect("custom page with page-asset passes");

    // Duplicate page id.
    manifest.ui.pages.push(runtime_plugin::PageDeclaration {
      id: "auth-page".into(),
      entry: "ui/index.html".into(),
    });
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);

    // Schema mode with pages -> InvalidField.
    manifest.ui.pages.pop();
    manifest.ui.mode = UiMode::Schema;
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidField);
  }

  #[test]
  fn runtime_plugin_contracts_unknown_key_rejected_at_parse() {
    let json = r#"{
      "manifestVersion": 1,
      "pluginApiVersion": "1.0",
      "id": "com.example.translate",
      "version": "1.0.0",
      "publisher": { "keyId": "k.id", "keyFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      "runtime": { "kind": "wasm-component", "artifact": "artifacts/plugin.wasm" },
      "files": [],
      "bogusField": true
    }"#;
    let err = parse_manifest(json).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::UnknownKey);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_missing_manifest() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.retain(|e| e.path != MANIFEST_FILE_PATH);
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_missing_signature() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.retain(|e| e.path != SIGNATURE_FILE_PATH);
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_unindexed_file() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.push(ArchiveEntry {
      path: "artifacts/extra.wasm".into(),
      bytes: 10,
      sha256: VALID_SHA.into(),
    });
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_absent_indexed_file() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.retain(|e| e.path != "artifacts/plugin.wasm");
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_digest_mismatch() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    for entry in entries.iter_mut() {
      if entry.path == "artifacts/plugin.wasm" {
        entry.sha256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
      }
    }
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidDigest);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_byte_length_mismatch() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    for entry in entries.iter_mut() {
      if entry.path == "artifacts/plugin.wasm" {
        entry.bytes = 9999;
      }
    }
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_duplicate_path() {
    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.push(ArchiveEntry {
      path: "artifacts/plugin.wasm".into(),
      bytes: 1024,
      sha256: VALID_SHA.into(),
    });
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::DuplicateId);
  }

  #[test]
  fn runtime_plugin_contracts_archive_rejects_portability_collisions() {
    let mut manifest = wasm_manifest();
    manifest.files.push(file("assets/Icon.png", FileRole::Icon, 128));
    manifest.files.push(file("assets/icon.png", FileRole::Icon, 128));
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidPath);

    let mut manifest = wasm_manifest();
    manifest.files.push(file("artifacts", FileRole::Other, 128));
    let err = validate_manifest(&manifest).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::InvalidPath);

    let manifest = wasm_manifest();
    let mut entries = archive_for(&manifest);
    entries.push(ArchiveEntry {
      path: "ARTIFACTS/PLUGIN.WASM".into(),
      bytes: 1024,
      sha256: VALID_SHA.into(),
    });
    let err = validate_archive_shape(&manifest, &entries).unwrap_err();
    assert_eq!(err.code, ContractErrorCode::ArchiveMismatch);
  }

  #[test]
  fn runtime_plugin_contracts_newtypes_validate() {
    assert!(PackageDigest::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").is_ok());
    assert!(PackageDigest::parse("XYZ").is_err());
    assert!(PublisherKeyId::parse("vendor.example").is_ok());
    assert!(PublisherKeyId::parse("Bad Case").is_err());
    assert!(PublisherKeyFingerprint::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").is_ok());
    assert!(runtime_plugin::GrantSetRevision::new(0).is_err());
    assert!(runtime_plugin::GrantSetRevision::new(1).is_ok());
    assert!(runtime_plugin::RequestId::parse(" req ").is_err());
    assert!(runtime_plugin::RequestId::parse("req-1").is_ok());
  }
}

// ABOUTME: Phase 0 WIT conformance module (rewritten): independent AST semantic assertions
// ABOUTME: over every record field, variant/enum case+payload, function signature, and world.
#[cfg(test)]
mod runtime_plugin_wit {
  use std::collections::HashSet;
  use std::path::PathBuf;
  use wit_parser::{Handle, Resolve, Type, TypeDefKind, WorldItem};

  fn wit_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wit/runtime-plugin")
  }

  fn resolve() -> (Resolve, wit_parser::PackageId) {
    let mut resolve = Resolve::new();
    match resolve.push_dir(&wit_dir()) {
      Ok((pkg_id, _sources)) => (resolve, pkg_id),
      Err(e) => panic!("wit/runtime-plugin parse failed: {e:?}"),
    }
  }

  fn iface(resolve: &Resolve, pkg_id: wit_parser::PackageId, name: &str) -> wit_parser::InterfaceId {
    *resolve.packages[pkg_id]
      .interfaces
      .get(name)
      .unwrap_or_else(|| panic!("interface {name} present"))
  }

  fn func<'a>(resolve: &'a Resolve, iface_id: wit_parser::InterfaceId, name: &str) -> &'a wit_parser::Function {
    resolve.interfaces[iface_id]
      .functions
      .get(name)
      .unwrap_or_else(|| panic!("function {name} present"))
  }

  fn type_id(resolve: &Resolve, iface_id: wit_parser::InterfaceId, name: &str) -> Type {
    Type::Id(
      *resolve.interfaces[iface_id]
        .types
        .get(name)
        .unwrap_or_else(|| panic!("type {name} present")),
    )
  }

  /// Unwrap `type X = Y;` aliases to the underlying type.
  fn resolve_alias(resolve: &Resolve, ty: Type) -> Type {
    let mut ty = ty;
    loop {
      match ty {
        Type::Id(id) => match &resolve.types[id].kind {
          TypeDefKind::Type(inner) => ty = *inner,
          _ => break,
        },
        _ => break,
      }
    }
    ty
  }

  /// Human-readable structural shape of a WIT type. Named records/variants/enums are expanded
  /// to their internals (fields, cases+payloads, cases) so assertions cover every token, not
  /// just a type name. Distinguishes borrow vs own and the named resource.
  fn type_shape(resolve: &Resolve, ty: Type) -> String {
    match resolve_alias(resolve, ty) {
      Type::Bool => "bool".to_string(),
      Type::U8 => "u8".to_string(),
      Type::U16 => "u16".to_string(),
      Type::U32 => "u32".to_string(),
      Type::U64 => "u64".to_string(),
      Type::F32 => "f32".to_string(),
      Type::F64 => "f64".to_string(),
      Type::String => "string".to_string(),
      Type::Id(id) => match &resolve.types[id].kind {
        TypeDefKind::Handle(Handle::Borrow(resource)) => {
          format!(
            "borrow<{}>",
            resolve.types[*resource].name.as_deref().unwrap_or("resource")
          )
        }
        TypeDefKind::Handle(Handle::Own(resource)) => {
          format!(
            "own<{}>",
            resolve.types[*resource].name.as_deref().unwrap_or("resource")
          )
        }
        TypeDefKind::List(Type::U8) => "list<u8>".to_string(),
        TypeDefKind::List(inner) => format!("list<{}>", type_shape(resolve, *inner)),
        TypeDefKind::Option(inner) => format!("option<{}>", type_shape(resolve, *inner)),
        TypeDefKind::Result(result) => format!(
          "result<{}, {}>",
          result
            .ok
            .map(|t| type_shape(resolve, t))
            .unwrap_or_else(|| "_".to_string()),
          result
            .err
            .map(|t| type_shape(resolve, t))
            .unwrap_or_else(|| "_".to_string())
        ),
        TypeDefKind::Tuple(tuple) => format!(
          "tuple<{}>",
          tuple
            .types
            .iter()
            .map(|t| type_shape(resolve, *t))
            .collect::<Vec<_>>()
            .join(", ")
        ),
        TypeDefKind::Record(record) => format!(
          "record{{{}}}",
          record
            .fields
            .iter()
            .map(|field| format!("{}: {}", field.name, type_shape(resolve, field.ty)))
            .collect::<Vec<_>>()
            .join(", ")
        ),
        TypeDefKind::Variant(variant) => format!(
          "variant{{{}}}",
          variant
            .cases
            .iter()
            .map(|case| match case.ty {
              Some(t) => format!("{}: {}", case.name, type_shape(resolve, t)),
              None => case.name.clone(),
            })
            .collect::<Vec<_>>()
            .join(", ")
        ),
        TypeDefKind::Enum(enumeration) => format!(
          "enum{{{}}}",
          enumeration
            .cases
            .iter()
            .map(|case| case.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
        ),
        TypeDefKind::Resource => resolve.types[id].name.clone().unwrap_or_else(|| "resource".to_string()),
        _ => "other".to_string(),
      },
      _ => "other".to_string(),
    }
  }

  /// (field-name, field-shape) pairs for a record, in declaration order.
  fn record_fields(resolve: &Resolve, ty: Type) -> Vec<(String, String)> {
    let Type::Id(id) = resolve_alias(resolve, ty) else {
      panic!("expected record");
    };
    let TypeDefKind::Record(record) = &resolve.types[id].kind else {
      panic!("expected record");
    };
    record
      .fields
      .iter()
      .map(|field| (field.name.clone(), type_shape(resolve, field.ty)))
      .collect()
  }

  /// (case-name, optional payload-shape) pairs for a variant, in declaration order.
  fn variant_cases(resolve: &Resolve, ty: Type) -> Vec<(String, Option<String>)> {
    let Type::Id(id) = resolve_alias(resolve, ty) else {
      panic!("expected variant");
    };
    let TypeDefKind::Variant(variant) = &resolve.types[id].kind else {
      panic!("expected variant");
    };
    variant
      .cases
      .iter()
      .map(|case| (case.name.clone(), case.ty.map(|t| type_shape(resolve, t))))
      .collect()
  }

  /// Case names for an enum, in declaration order.
  fn enum_cases(resolve: &Resolve, ty: Type) -> Vec<String> {
    let Type::Id(id) = resolve_alias(resolve, ty) else {
      panic!("expected enum");
    };
    let TypeDefKind::Enum(enumeration) = &resolve.types[id].kind else {
      panic!("expected enum");
    };
    enumeration.cases.iter().map(|case| case.name.clone()).collect()
  }

  fn interface_function_names(resolve: &Resolve, interface: wit_parser::InterfaceId) -> Vec<&str> {
    resolve.interfaces[interface]
      .functions
      .keys()
      .map(String::as_str)
      .collect()
  }

  fn function_parameter_names(function: &wit_parser::Function) -> Vec<&str> {
    function.params.iter().map(|(name, _)| name.as_str()).collect()
  }

  fn assert_params(resolve: &Resolve, iface_id: wit_parser::InterfaceId, fn_name: &str, expected: &[(&str, &str)]) {
    let function = func(resolve, iface_id, fn_name);
    let actual: Vec<(String, String)> = function
      .params
      .iter()
      .map(|(name, ty)| (name.clone(), type_shape(resolve, *ty)))
      .collect();
    let expected: Vec<(String, String)> = expected.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect();
    assert_eq!(actual, expected, "{fn_name} parameter (name, shape) pairs");
  }

  fn assert_result_shape(resolve: &Resolve, iface_id: wit_parser::InterfaceId, fn_name: &str, expected: &str) {
    let result = func(resolve, iface_id, fn_name)
      .result
      .unwrap_or_else(|| panic!("{fn_name} has a result"));
    assert_eq!(type_shape(resolve, result), expected, "{fn_name} result shape");
  }

  fn assert_no_result(resolve: &Resolve, iface_id: wit_parser::InterfaceId, fn_name: &str) {
    assert!(
      func(resolve, iface_id, fn_name).result.is_none(),
      "{fn_name} must have no result"
    );
  }

  /// The golden files freeze every token of the v1 ABI. The AST assertions below independently
  /// prove the frozen source remains valid and structurally exact.
  #[test]
  fn runtime_plugin_wit_matches_complete_v1_golden_abi() {
    let files = [
      (
        "common.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/common.wit.golden"),
        include_str!("../../wit/runtime-plugin/common.wit"),
      ),
      (
        "host.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/host.wit.golden"),
        include_str!("../../wit/runtime-plugin/host.wit"),
      ),
      (
        "translate.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/translate.wit.golden"),
        include_str!("../../wit/runtime-plugin/translate.wit"),
      ),
      (
        "ocr.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/ocr.wit.golden"),
        include_str!("../../wit/runtime-plugin/ocr.wit"),
      ),
      (
        "speech.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/speech.wit.golden"),
        include_str!("../../wit/runtime-plugin/speech.wit"),
      ),
      (
        "llm.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/llm.wit.golden"),
        include_str!("../../wit/runtime-plugin/llm.wit"),
      ),
      (
        "worlds.wit",
        include_str!("../../wit/runtime-plugin-golden-v1/worlds.wit.golden"),
        include_str!("../../wit/runtime-plugin/worlds.wit"),
      ),
    ];
    for (name, golden, current) in files {
      assert_eq!(current, golden, "{name} changes the locked runtime-plugin v1 ABI");
    }
  }

  #[test]
  fn runtime_plugin_wit_package_version_locked() {
    let (resolve, pkg_id) = resolve();
    let pkg = &resolve.packages[pkg_id];
    assert_eq!(pkg.name.namespace, "langnext");
    assert_eq!(pkg.name.name, "runtime-plugin");
    assert_eq!(pkg.name.version.as_ref().map(|v| v.to_string()).unwrap(), "1.0.0");
  }

  #[test]
  fn runtime_plugin_wit_no_forbidden_imports() {
    let (resolve, pkg_id) = resolve();
    for (world_name, world_id) in &resolve.packages[pkg_id].worlds {
      let world = &resolve.worlds[*world_id];
      for (_, item) in &world.imports {
        if let WorldItem::Interface { id, .. } = item {
          let namespace = resolve.interfaces[*id]
            .package
            .map(|pid| resolve.packages[pid].name.namespace.clone())
            .unwrap_or_default();
          assert_eq!(
            namespace, "langnext",
            "world {world_name} imports forbidden namespace {namespace}"
          );
        }
      }
    }
  }

  #[test]
  fn runtime_plugin_wit_all_worlds_derive_from_capability_specs() {
    let (resolve, pkg_id) = resolve();
    let worlds: HashSet<&str> = resolve.packages[pkg_id].worlds.keys().map(|n| n.as_str()).collect();
    let mut expected: HashSet<&str> = crate::domain::runtime_plugin::CAPABILITY_SPECS
      .iter()
      .map(|s| s.world)
      .collect();
    expected.insert("migration-world");
    assert_eq!(
      worlds, expected,
      "WIT worlds must be capability-spec worlds plus migration"
    );
  }

  /// Assert every record's field order and field types are exact.
  #[test]
  fn runtime_plugin_wit_all_records_fields_exact() {
    let (resolve, pkg_id) = resolve();
    let common = iface(&resolve, pkg_id, "common");
    let host = iface(&resolve, pkg_id, "host");

    let cases: &[(&str, wit_parser::InterfaceId, &[(&str, &str)])] = &[
      (
        "media-metadata",
        common,
        &[("content-type", "option<string>"), ("byte-length", "option<u64>")],
      ),
      (
        "llm-tool-call-delta",
        common,
        &[("id", "string"), ("name", "string"), ("arguments-json", "list<u8>")],
      ),
      (
        "broker-request",
        host,
        &[
          ("endpoint-id", "string"),
          ("relative-path", "string"),
          ("method", "string"),
          ("headers", "list<tuple<string, string>>"),
          ("body", "variant{empty, json: list<u8>, blob: own<blob-handle>}"),
        ],
      ),
      (
        "broker-response",
        host,
        &[
          ("status", "u16"),
          ("headers", "list<tuple<string, string>>"),
          (
            "body",
            "variant{json: list<u8>, blob: own<blob-handle>, stream: own<stream-reader>}",
          ),
        ],
      ),
    ];
    for (name, iface_id, expected) in cases {
      let actual = record_fields(&resolve, type_id(&resolve, *iface_id, name));
      let expected: Vec<(String, String)> = expected.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect();
      assert_eq!(actual, expected, "record {name} fields");
    }

    // Capability-interface records.
    let tt = iface(&resolve, pkg_id, "translate-text");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, tt, "text-request")),
      vec![
        ("request-id".into(), "string".into()),
        ("text".into(), "string".into()),
        ("source-language-id".into(), "string".into()),
        ("target-language-id".into(), "string".into()),
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, tt, "text-response")),
      vec![
        ("translated-text".into(), "string".into()),
        ("detected-source-language-id".into(), "option<string>".into())
      ]
    );

    let td = iface(&resolve, pkg_id, "translate-detect");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, td, "detect-request")),
      vec![("request-id".into(), "string".into()), ("text".into(), "string".into())]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, td, "detect-response")),
      vec![
        ("language-id".into(), "string".into()),
        ("confidence".into(), "option<f32>".into())
      ]
    );

    let ocr = iface(&resolve, pkg_id, "ocr-image");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, ocr, "ocr-preferences")),
      vec![
        ("operation".into(), "option<string>".into()),
        ("language-hints".into(), "list<string>".into())
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, ocr, "image-request")),
      vec![
        ("request-id".into(), "string".into()),
        ("input".into(), "borrow<blob-handle>".into()),
        (
          "preferences".into(),
          "record{operation: option<string>, language-hints: list<string>}".into()
        ),
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, ocr, "image-response")),
      vec![("text".into(), "string".into())]
    );

    let synth = iface(&resolve, pkg_id, "speech-synthesize");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, synth, "synthesize-request")),
      vec![
        ("request-id".into(), "string".into()),
        ("text".into(), "string".into()),
        ("language-id".into(), "string".into()),
        ("preferences".into(), "list<u8>".into()),
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, synth, "synthesize-response")),
      vec![
        ("output".into(), "own<blob-handle>".into()),
        (
          "media".into(),
          "record{content-type: option<string>, byte-length: option<u64>}".into()
        ),
      ]
    );

    let recog = iface(&resolve, pkg_id, "speech-recognize");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, recog, "recognize-request")),
      vec![
        ("request-id".into(), "string".into()),
        ("input".into(), "borrow<blob-handle>".into()),
        ("language-id".into(), "option<string>".into()),
        ("preferences".into(), "list<u8>".into()),
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, recog, "recognize-response")),
      vec![("text".into(), "string".into())]
    );

    let models = iface(&resolve, pkg_id, "llm-models");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, models, "models-list-request")),
      vec![("request-id".into(), "string".into())]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, models, "model-descriptor")),
      vec![
        ("id".into(), "string".into()),
        ("label".into(), "option<string>".into())
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, models, "models-list-response")),
      vec![(
        "models".into(),
        "list<record{id: string, label: option<string>}>".into()
      )]
    );

    let chat = iface(&resolve, pkg_id, "llm-chat");
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, chat, "chat-message")),
      vec![("role".into(), "string".into()), ("content".into(), "string".into())]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, chat, "chat-request")),
      vec![
        ("request-id".into(), "string".into()),
        ("model".into(), "string".into()),
        ("messages".into(), "list<record{role: string, content: string}>".into()),
        ("images".into(), "list<borrow<blob-handle>>".into()),
        ("preferences".into(), "list<u8>".into()),
      ]
    );
    assert_eq!(
      record_fields(&resolve, type_id(&resolve, chat, "chat-response")),
      vec![("message".into(), "record{role: string, content: string}".into())]
    );
  }

  /// Assert every variant's case order, case names, and payload types are exact.
  #[test]
  fn runtime_plugin_wit_all_variants_cases_exact() {
    let (resolve, pkg_id) = resolve();
    let common = iface(&resolve, pkg_id, "common");
    let host = iface(&resolve, pkg_id, "host");
    let chat = iface(&resolve, pkg_id, "llm-chat");

    let none = || None::<String>;
    let some = |s: &str| Some(s.to_string());

    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, common, "plugin-error")),
      vec![
        ("invalid-request".into(), some("string")),
        ("invalid-configuration".into(), none()),
        ("invalid-input".into(), some("string")),
        ("auth".into(), none()),
        ("permission-denied".into(), none()),
        ("quota-exceeded".into(), none()),
        ("rate-limited".into(), none()),
        ("unsupported-input".into(), some("string")),
        ("unsupported-language".into(), some("string")),
        ("network".into(), some("string")),
        ("timeout".into(), none()),
        ("invalid-response".into(), some("string")),
        ("provider-unavailable".into(), none()),
        ("plugin-unavailable".into(), none()),
        ("cancelled".into(), none()),
        ("internal".into(), some("string")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, common, "resource-error")),
      vec![
        ("not-owned".into(), none()),
        ("wrong-direction".into(), none()),
        ("exhausted".into(), none()),
        ("out-of-bounds".into(), none()),
        ("closed".into(), none()),
        ("cancelled".into(), none()),
        ("internal".into(), some("string")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, common, "llm-delta")),
      vec![
        ("text".into(), some("string")),
        ("reasoning".into(), some("string")),
        (
          "tool-call".into(),
          some("record{id: string, name: string, arguments-json: list<u8>}")
        ),
        ("complete".into(), some("enum{stop, length, tool-calls}")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, common, "stream-frame")),
      vec![
        ("network-binary".into(), some("list<u8>")),
        (
          "llm-delta".into(),
          some(
            "variant{text: string, reasoning: string, tool-call: record{id: string, name: string, arguments-json: list<u8>}, complete: enum{stop, length, tool-calls}}"
          )
        ),
        ("terminal".into(), some("variant{finished, failed: string, cancelled}")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, common, "stream-terminal-state")),
      vec![
        ("finished".into(), none()),
        ("failed".into(), some("string")),
        ("cancelled".into(), none())
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, host, "broker-body-request")),
      vec![
        ("empty".into(), none()),
        ("json".into(), some("list<u8>")),
        ("blob".into(), some("own<blob-handle>"))
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, host, "broker-body-response")),
      vec![
        ("json".into(), some("list<u8>")),
        ("blob".into(), some("own<blob-handle>")),
        ("stream".into(), some("own<stream-reader>")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, host, "broker-error")),
      vec![
        ("not-approved".into(), none()),
        ("method-not-allowed".into(), none()),
        ("path-confined".into(), none()),
        ("header-blocked".into(), none()),
        ("network".into(), some("string")),
        ("timeout".into(), none()),
        ("cancelled".into(), none()),
        ("limit-exceeded".into(), none()),
        ("internal".into(), some("string")),
      ]
    );
    assert_eq!(
      variant_cases(&resolve, type_id(&resolve, chat, "chat-result")),
      vec![
        (
          "complete".into(),
          some("record{message: record{role: string, content: string}}")
        ),
        ("streaming".into(), none()),
      ]
    );
  }

  /// Assert every enum's case order and names are exact.
  #[test]
  fn runtime_plugin_wit_all_enums_cases_exact() {
    let (resolve, pkg_id) = resolve();
    let common = iface(&resolve, pkg_id, "common");
    let host = iface(&resolve, pkg_id, "host");
    assert_eq!(
      enum_cases(&resolve, type_id(&resolve, common, "blob-direction")),
      vec!["input", "output"]
    );
    assert_eq!(
      enum_cases(&resolve, type_id(&resolve, common, "stream-kind")),
      vec!["network-binary", "llm-delta"]
    );
    assert_eq!(
      enum_cases(&resolve, type_id(&resolve, common, "llm-completion-status")),
      vec!["stop", "length", "tool-calls"]
    );
    assert_eq!(
      enum_cases(&resolve, type_id(&resolve, host, "log-level")),
      vec!["trace", "debug", "info", "warn", "error"]
    );
  }

  /// Assert every function's parameter (name, shape) pairs and result shape are exact, across
  /// host, every capability interface, and migration.
  #[test]
  fn runtime_plugin_wit_all_functions_signatures_exact() {
    let (resolve, pkg_id) = resolve();
    let host = iface(&resolve, pkg_id, "host");

    assert_params(
      &resolve,
      host,
      "broker-fetch",
      &[(
        "request",
        "record{endpoint-id: string, relative-path: string, method: string, headers: list<tuple<string, string>>, body: variant{empty, json: list<u8>, blob: own<blob-handle>}}",
      )],
    );
    assert_result_shape(
      &resolve,
      host,
      "broker-fetch",
      "result<record{status: u16, headers: list<tuple<string, string>>, body: variant{json: list<u8>, blob: own<blob-handle>, stream: own<stream-reader>}}, variant{not-approved, method-not-allowed, path-confined, header-blocked, network: string, timeout, cancelled, limit-exceeded, internal: string}>",
    );

    assert_params(
      &resolve,
      host,
      "log",
      &[
        ("level", "enum{trace, debug, info, warn, error}"),
        ("message", "string"),
        ("fields", "list<tuple<string, string>>"),
      ],
    );
    assert_no_result(&resolve, host, "log");
    assert_params(&resolve, host, "deadline-remaining", &[]);
    assert_result_shape(&resolve, host, "deadline-remaining", "option<u64>");
    assert_params(&resolve, host, "is-cancelled", &[]);
    assert_result_shape(&resolve, host, "is-cancelled", "bool");

    assert_params(
      &resolve,
      host,
      "blob-create",
      &[
        ("direction", "enum{input, output}"),
        ("content-type", "option<string>"),
        ("max-bytes", "u64"),
      ],
    );
    assert_result_shape(
      &resolve,
      host,
      "blob-create",
      "result<own<blob-handle>, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(
      &resolve,
      host,
      "blob-write",
      &[
        ("handle", "borrow<blob-handle>"),
        ("offset", "u64"),
        ("bytes", "list<u8>"),
      ],
    );
    assert_result_shape(
      &resolve,
      host,
      "blob-write",
      "result<u64, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(
      &resolve,
      host,
      "blob-read",
      &[
        ("handle", "borrow<blob-handle>"),
        ("offset", "u64"),
        ("max-bytes", "u64"),
      ],
    );
    assert_result_shape(
      &resolve,
      host,
      "blob-read",
      "result<list<u8>, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(&resolve, host, "blob-length", &[("handle", "borrow<blob-handle>")]);
    assert_result_shape(
      &resolve,
      host,
      "blob-length",
      "result<u64, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(&resolve, host, "blob-metadata", &[("handle", "borrow<blob-handle>")]);
    assert_result_shape(
      &resolve,
      host,
      "blob-metadata",
      "result<record{content-type: option<string>, byte-length: option<u64>}, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(&resolve, host, "blob-close", &[("handle", "own<blob-handle>")]);
    assert_result_shape(
      &resolve,
      host,
      "blob-close",
      "result<_, variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}>",
    );
    assert_params(&resolve, host, "blob-discard", &[("handle", "own<blob-handle>")]);
    assert_no_result(&resolve, host, "blob-discard");

    let resource_err =
      "variant{not-owned, wrong-direction, exhausted, out-of-bounds, closed, cancelled, internal: string}";
    assert_params(
      &resolve,
      host,
      "stream-create",
      &[
        ("kind", "enum{network-binary, llm-delta}"),
        ("content-type", "option<string>"),
        ("max-bytes", "u64"),
      ],
    );
    assert_result_shape(
      &resolve,
      host,
      "stream-create",
      &format!("result<tuple<own<stream-writer>, own<stream-reader>>, {resource_err}>"),
    );
    let frame = "variant{network-binary: list<u8>, llm-delta: variant{text: string, reasoning: string, tool-call: record{id: string, name: string, arguments-json: list<u8>}, complete: enum{stop, length, tool-calls}}, terminal: variant{finished, failed: string, cancelled}}";
    assert_params(
      &resolve,
      host,
      "stream-send",
      &[("writer", "borrow<stream-writer>"), ("frame", frame)],
    );
    assert_result_shape(&resolve, host, "stream-send", &format!("result<_, {resource_err}>"));
    assert_params(&resolve, host, "stream-receive", &[("reader", "borrow<stream-reader>")]);
    assert_result_shape(
      &resolve,
      host,
      "stream-receive",
      &format!("result<option<{frame}>, {resource_err}>"),
    );
    assert_params(&resolve, host, "stream-state", &[("reader", "borrow<stream-reader>")]);
    assert_result_shape(
      &resolve,
      host,
      "stream-state",
      &format!("result<option<variant{{finished, failed: string, cancelled}}>, {resource_err}>"),
    );
    assert_params(&resolve, host, "stream-finish", &[("writer", "own<stream-writer>")]);
    assert_result_shape(&resolve, host, "stream-finish", &format!("result<_, {resource_err}>"));
    assert_params(
      &resolve,
      host,
      "stream-fail",
      &[("writer", "own<stream-writer>"), ("code", "string")],
    );
    assert_result_shape(&resolve, host, "stream-fail", &format!("result<_, {resource_err}>"));
    assert_params(&resolve, host, "stream-cancel", &[("reader", "borrow<stream-reader>")]);
    assert_result_shape(&resolve, host, "stream-cancel", &format!("result<_, {resource_err}>"));
    assert_params(
      &resolve,
      host,
      "stream-metadata",
      &[("reader", "borrow<stream-reader>")],
    );
    assert_result_shape(
      &resolve,
      host,
      "stream-metadata",
      &format!("result<record{{content-type: option<string>, byte-length: option<u64>}}, {resource_err}>"),
    );
    assert_params(
      &resolve,
      host,
      "stream-reader-close",
      &[("reader", "own<stream-reader>")],
    );
    assert_result_shape(
      &resolve,
      host,
      "stream-reader-close",
      &format!("result<_, {resource_err}>"),
    );
    assert_params(
      &resolve,
      host,
      "stream-reader-discard",
      &[("reader", "own<stream-reader>")],
    );
    assert_no_result(&resolve, host, "stream-reader-discard");

    let plugin_err = "variant{invalid-request: string, invalid-configuration, invalid-input: string, auth, permission-denied, quota-exceeded, rate-limited, unsupported-input: string, unsupported-language: string, network: string, timeout, invalid-response: string, provider-unavailable, plugin-unavailable, cancelled, internal: string}";
    let tt = iface(&resolve, pkg_id, "translate-text");
    assert_params(
      &resolve,
      tt,
      "text",
      &[
        ("config", "list<u8>"),
        ("preferences", "list<u8>"),
        (
          "request",
          "record{request-id: string, text: string, source-language-id: string, target-language-id: string}",
        ),
      ],
    );
    assert_result_shape(
      &resolve,
      tt,
      "text",
      &format!("result<record{{translated-text: string, detected-source-language-id: option<string>}}, {plugin_err}>"),
    );
    let td = iface(&resolve, pkg_id, "translate-detect");
    assert_params(
      &resolve,
      td,
      "detect",
      &[
        ("config", "list<u8>"),
        ("preferences", "list<u8>"),
        ("request", "record{request-id: string, text: string}"),
      ],
    );
    assert_result_shape(
      &resolve,
      td,
      "detect",
      &format!("result<record{{language-id: string, confidence: option<f32>}}, {plugin_err}>"),
    );
    let ocr = iface(&resolve, pkg_id, "ocr-image");
    assert_params(
      &resolve,
      ocr,
      "image",
      &[
        ("config", "list<u8>"),
        (
          "request",
          "record{request-id: string, input: borrow<blob-handle>, preferences: record{operation: option<string>, language-hints: list<string>}}",
        ),
      ],
    );
    assert_result_shape(
      &resolve,
      ocr,
      "image",
      &format!("result<record{{text: string}}, {plugin_err}>"),
    );
    let synth = iface(&resolve, pkg_id, "speech-synthesize");
    assert_params(
      &resolve,
      synth,
      "synthesize",
      &[
        ("config", "list<u8>"),
        (
          "request",
          "record{request-id: string, text: string, language-id: string, preferences: list<u8>}",
        ),
      ],
    );
    assert_result_shape(
      &resolve,
      synth,
      "synthesize",
      &format!(
        "result<record{{output: own<blob-handle>, media: record{{content-type: option<string>, byte-length: option<u64>}}}}, {plugin_err}>"
      ),
    );
    let recog = iface(&resolve, pkg_id, "speech-recognize");
    assert_params(
      &resolve,
      recog,
      "recognize",
      &[
        ("config", "list<u8>"),
        (
          "request",
          "record{request-id: string, input: borrow<blob-handle>, language-id: option<string>, preferences: list<u8>}",
        ),
      ],
    );
    assert_result_shape(
      &resolve,
      recog,
      "recognize",
      &format!("result<record{{text: string}}, {plugin_err}>"),
    );
    let models = iface(&resolve, pkg_id, "llm-models");
    assert_params(
      &resolve,
      models,
      "models-list",
      &[("config", "list<u8>"), ("request", "record{request-id: string}")],
    );
    assert_result_shape(
      &resolve,
      models,
      "models-list",
      &format!("result<record{{models: list<record{{id: string, label: option<string>}}>}}, {plugin_err}>"),
    );
    let chat = iface(&resolve, pkg_id, "llm-chat");
    assert_params(
      &resolve,
      chat,
      "chat",
      &[
        ("config", "list<u8>"),
        (
          "request",
          "record{request-id: string, model: string, messages: list<record{role: string, content: string}>, images: list<borrow<blob-handle>>, preferences: list<u8>}",
        ),
        ("output", "own<stream-writer>"),
      ],
    );
    assert_result_shape(
      &resolve,
      chat,
      "chat",
      &format!(
        "result<variant{{complete: record{{message: record{{role: string, content: string}}}}, streaming}}, {plugin_err}>"
      ),
    );

    let migration = iface(&resolve, pkg_id, "migration");
    assert_params(
      &resolve,
      migration,
      "migrate-config",
      &[("from-version", "u32"), ("to-version", "u32"), ("config", "list<u8>")],
    );
    assert_result_shape(
      &resolve,
      migration,
      "migrate-config",
      &format!("result<list<u8>, {plugin_err}>"),
    );
    assert_params(
      &resolve,
      migration,
      "migrate-preferences",
      &[
        ("capability", "string"),
        ("from-version", "u32"),
        ("to-version", "u32"),
        ("preferences", "list<u8>"),
      ],
    );
    assert_result_shape(
      &resolve,
      migration,
      "migrate-preferences",
      &format!("result<list<u8>, {plugin_err}>"),
    );

    // Function-name sets per interface are exact (declaration order, no extra/missing functions).
    assert_eq!(
      interface_function_names(&resolve, host),
      vec![
        "broker-fetch",
        "log",
        "deadline-remaining",
        "is-cancelled",
        "blob-create",
        "blob-write",
        "blob-read",
        "blob-length",
        "blob-metadata",
        "blob-close",
        "blob-discard",
        "stream-create",
        "stream-send",
        "stream-receive",
        "stream-state",
        "stream-finish",
        "stream-fail",
        "stream-cancel",
        "stream-metadata",
        "stream-reader-close",
        "stream-reader-discard"
      ]
    );
    assert_eq!(interface_function_names(&resolve, tt), vec!["text"]);
    assert_eq!(interface_function_names(&resolve, td), vec!["detect"]);
    assert_eq!(interface_function_names(&resolve, ocr), vec!["image"]);
    assert_eq!(interface_function_names(&resolve, synth), vec!["synthesize"]);
    assert_eq!(interface_function_names(&resolve, recog), vec!["recognize"]);
    assert_eq!(interface_function_names(&resolve, models), vec!["models-list"]);
    assert_eq!(interface_function_names(&resolve, chat), vec!["chat"]);
    assert_eq!(
      interface_function_names(&resolve, migration),
      vec!["migrate-config", "migrate-preferences"]
    );
  }

  /// Assert every world's imports and exports are exact, including migration-world's export.
  #[test]
  fn runtime_plugin_wit_all_worlds_imports_exports_exact() {
    let (resolve, pkg_id) = resolve();
    let imports_exports = |world_name: &str| -> (Vec<String>, Vec<String>) {
      let world_id = *resolve.packages[pkg_id]
        .worlds
        .get(world_name)
        .unwrap_or_else(|| panic!("world {world_name} present"));
      let world = &resolve.worlds[world_id];
      let imports: Vec<String> = world
        .imports
        .iter()
        .filter_map(|(_, item)| match item {
          WorldItem::Interface { id, .. } => resolve.interfaces[*id].name.clone(),
          _ => None,
        })
        .collect();
      let exports: Vec<String> = world
        .exports
        .iter()
        .filter_map(|(_, item)| match item {
          WorldItem::Interface { id, .. } => resolve.interfaces[*id].name.clone(),
          _ => None,
        })
        .collect();
      (imports, exports)
    };
    for spec in crate::domain::runtime_plugin::CAPABILITY_SPECS {
      let (imports, exports) = imports_exports(spec.world);
      assert_eq!(
        imports,
        vec!["common".to_string(), "host".to_string()],
        "world {} imports",
        spec.world
      );
      assert_eq!(
        exports,
        vec![spec.interface.to_string()],
        "world {} exports",
        spec.world
      );
    }
    let (migration_imports, migration_exports) = imports_exports("migration-world");
    assert_eq!(migration_imports, vec!["common".to_string()], "migration-world imports");
    assert_eq!(
      migration_exports,
      vec!["migration".to_string()],
      "migration-world exports migration"
    );
  }
}
