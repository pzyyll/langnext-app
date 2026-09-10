// ABOUTME: Provider runtime package catalog and adapter-keyed interface lifecycle services.
// ABOUTME: Catalog visibility never grants execution; each binding owns one exact API type.
use crate::domain::plugin_catalog::compute_permission_request_digest;
use crate::domain::provider::{BaseUrlSource, ProviderInstance, ProviderInstanceWrite, ProxyMode, validate_adapter_id};
use crate::domain::runtime_lifecycle::{
  CapabilityGrantEntryRecord, ExecutionGrantSetBundle, ExecutionGrantSetRecord, GrantSubjectKind,
  RUNTIME_PREVIEW_TTL_SECS,
};
use crate::domain::runtime_plugin::{
  CapabilityId, ComponentArtifactDigest, ExecutionGrantSet, PackageDigest, PackageIdentity, PluginId, PluginManifestV1,
  ProviderRuntimeDeclaration, RuntimeIdentity, RuntimeKind, SemVerVersion,
};
use crate::domain::runtime_provider::{
  ApplyProviderRuntimeInterfaceAttachInput, ApplyProviderRuntimeInterfaceRollbackInput,
  ApplyProviderRuntimeRollbackInput, PreviewProviderRuntimeInterfaceAttachInput,
  PreviewProviderRuntimeInterfaceRollbackInput, ProviderRuntimeBinding, ProviderRuntimeBindingDto,
  ProviderRuntimeCatalogCapabilityDto, ProviderRuntimeCatalogEntryDto, ProviderRuntimeDetectionDto,
  ProviderRuntimeInterfaceDetachInput, ProviderRuntimeInterfaceDiscardSnapshotInput,
  ProviderRuntimeInterfaceLifecycleResultDto, ProviderRuntimeInterfacePreviewDto,
  ProviderRuntimeInterfaceRollbackPreviewDto, ProviderRuntimeKind, ProviderRuntimeLifecycleResultDto,
  ProviderRuntimeRollbackPreviewDto, ProviderRuntimeSnapshotDto, ProviderRuntimeState,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::provider_runtime_bindings::{
  ProviderRuntimeSnapshotBinding, ProviderRuntimeSnapshotScope, ProviderRuntimeSnapshotSet,
};
use crate::repositories::{plugin_permission_grants, provider_instances, provider_runtime_bindings};
use crate::services::plugin_catalog::{PinnedContent, PluginCatalog};
use crate::services::plugin_loader::LoadedPlugin;
use crate::services::runtime_plugin_contracts::validate_manifest;
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Stable capability ids required by every provider runtime declaration.
const REQUIRED_LLM_CAPABILITIES: [&str; 2] = ["llm.models.list@1", "llm.chat@1"];

/// Verified provider runtime package catalog.
///
/// Lists only installed packages whose manifest declares a valid `providerRuntime`
/// declaration. Every artifact is re-verified through the package store and compiled to prove
/// it instantiates exactly its declared LLM world with no non-langnext imports. A malformed or
/// ambiguous declaration fails the whole listing closed: an installed provider-runtime package
/// must never silently disappear from review.
pub struct ProviderRuntimeCatalog {
  db: Database,
  catalog: std::sync::Arc<PluginCatalog>,
  wasm: Arc<WasmRuntime>,
}

/// Outcome of re-verifying one installed package as a provider-runtime candidate. The
/// "no providerRuntime declaration" case is a typed outcome, never a message classification,
/// so catalog behavior cannot change when error wording changes.
enum PackageVerification {
  /// The manifest declares a valid `providerRuntime` block.
  ProviderRuntime(LoadedPlugin, PluginManifestV1, ProviderRuntimeDeclaration),
  /// The installed package is a regular plugin without a `providerRuntime` declaration.
  NotProviderRuntime,
}

impl ProviderRuntimeCatalog {
  pub fn new(db: Database, catalog: std::sync::Arc<PluginCatalog>, wasm: Arc<WasmRuntime>) -> Self {
    Self { db, catalog, wasm }
  }

  /// Re-verify one installed provider-runtime package: contract validation, catalog snapshot
  /// re-verification, and per-capability artifact world checks. Shared by catalog listing and
  /// the lifecycle preview/apply seams.
  fn verify_package(&self, loaded: &LoadedPlugin) -> Result<PackageVerification, StorageError> {
    let manifest: PluginManifestV1 = loaded.manifest.clone();
    let Some(declaration) = manifest.provider_runtime.clone() else {
      return Ok(PackageVerification::NotProviderRuntime);
    };
    if manifest.runtime.kind != RuntimeKind::WasmComponent {
      return Err(StorageError::Validation(format!(
        "provider runtime package {} declares providerRuntime with non-wasm runtime",
        manifest.id
      )));
    }
    // Full contract validation of the manifest shape (fail closed on malformed cases).
    validate_manifest(&manifest)
      .map_err(|e| StorageError::Validation(format!("provider runtime package {}: {e}", manifest.id)))?;

    let package_digest = PackageDigest::parse(&loaded.descriptor.content_digest)
      .map_err(|e| StorageError::Validation(format!("provider runtime package digest: {e}")))?;
    for (capability_id, artifact_path) in &declaration.capabilities {
      let artifact_digest = manifest
        .files
        .iter()
        .find(|file| &file.path == artifact_path)
        .ok_or_else(|| {
          StorageError::Validation(format!(
            "provider runtime capability {capability_id} artifact {artifact_path} is not indexed"
          ))
        })?
        .sha256
        .clone();
      let artifact_digest = ComponentArtifactDigest::parse(&artifact_digest)
        .map_err(|e| StorageError::Validation(format!("provider runtime artifact digest: {e}")))?;
      let bytes = loaded.read_snapshot_file(artifact_path).map_err(|_| {
        StorageError::Validation(format!(
          "provider runtime capability {capability_id} artifact {artifact_path} is missing from the snapshot"
        ))
      })?;
      let world = match capability_id.as_str() {
        "llm.models.list@1" => "llm-models-world",
        "llm.chat@1" => "llm-chat-world",
        other => {
          return Err(StorageError::Validation(format!(
            "provider runtime declares unsupported capability {other}"
          )));
        }
      };
      self
        .wasm
        .verify_artifact_world(&package_digest, &artifact_digest, &bytes, world)
        .map_err(|e| {
          StorageError::Validation(format!(
            "provider runtime package {} capability {capability_id}: {e}",
            manifest.id
          ))
        })?;
    }
    Ok(PackageVerification::ProviderRuntime(
      loaded.clone(),
      manifest,
      declaration,
    ))
  }

  /// Project sanitized catalog metadata for every verified provider-runtime package.
  pub fn list(&self) -> Result<Vec<ProviderRuntimeCatalogEntryDto>, StorageError> {
    let loaded_entries: Vec<LoadedPlugin> = self
      .catalog
      .descriptors()
      .into_iter()
      .filter_map(|descriptor| self.catalog.snapshot_optional(&descriptor.content_digest))
      .collect();
    let mut entries = Vec::new();
    for version in loaded_entries {
      let (_verified, manifest, declaration) = match self.verify_package(&version) {
        Ok(PackageVerification::ProviderRuntime(verified, manifest, declaration)) => (verified, manifest, declaration),
        Ok(PackageVerification::NotProviderRuntime) => continue,
        Err(err) => return Err(err),
      };
      let mut capabilities = Vec::with_capacity(declaration.capabilities.len());
      for (capability_id, artifact_path) in &declaration.capabilities {
        let artifact_digest = manifest
          .files
          .iter()
          .find(|file| &file.path == artifact_path)
          .ok_or_else(|| {
            StorageError::Validation(format!(
              "provider runtime capability {capability_id} artifact {artifact_path} is not indexed"
            ))
          })?
          .sha256
          .clone();
        capabilities.push(ProviderRuntimeCatalogCapabilityDto {
          capability_id: capability_id.clone(),
          artifact_path: artifact_path.clone(),
          artifact_digest,
        });
      }
      capabilities.sort_by(|a, b| a.capability_id.cmp(&b.capability_id));

      entries.push(ProviderRuntimeCatalogEntryDto {
        plugin_id: manifest.id.clone(),
        version: manifest.version.clone(),
        package_digest: version.descriptor.content_digest.clone(),
        legacy_aliases: declaration.legacy_aliases.clone(),
        capabilities,
        detection: declaration
          .detection
          .clone()
          .map(|detection| ProviderRuntimeDetectionDto {
            max_tokens: detection.max_tokens,
            thinking: detection.thinking,
          }),
      });
    }
    entries.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    Ok(entries)
  }
}

/// One previewed provider runtime interface attach/replace, bound to the provider `updated_at`
/// CAS and the exact target package identity for ONE API type. Consumed exactly once by apply.
#[derive(Debug, Clone)]
struct ProviderInterfaceAttachPreviewSession {
  preview_id: String,
  provider_id: Uuid,
  adapter_id: String,
  expected_updated_at: String,
  /// Previewed source binding; `source_row_present` distinguishes an existing row from a
  /// synthesized legacy identity for a never-attached non-default adapter.
  source: ProviderRuntimeBinding,
  source_row_present: bool,
  target_package_digest: String,
  target_plugin_id: String,
  target_plugin_version: String,
  target_legacy_aliases: Vec<String>,
  /// `None` when the Provider already holds the exact Provider/package grant (alias reuse).
  grant_bundle: Option<ExecutionGrantSetBundle>,
  grant_revision: u64,
  snapshot: ProviderRuntimeSnapshotSet,
  snapshot_child: ProviderRuntimeSnapshotBinding,
  requires_permission_approval: bool,
  expires_at: Instant,
}

/// One previewed provider runtime interface rollback, bound to one adapter-scoped snapshot
/// set or a migrated Provider-scoped set.
#[derive(Debug, Clone)]
struct ProviderInterfaceRollbackPreviewSession {
  preview_id: String,
  provider_id: Uuid,
  adapter_id: String,
  expected_updated_at: String,
  current: ProviderRuntimeBinding,
  snapshot_set_id: Uuid,
  snapshot_scope: ProviderRuntimeSnapshotScope,
  expires_at: Instant,
}

/// Pre-verified catalog default candidate for ONE new Provider create. Resolution is read-only
/// and happens before the create transaction; the transaction inserts only the selected binding.
#[derive(Debug, Clone)]
pub(crate) struct PreparedProviderDefault {
  pub content: PinnedContent,
  pub declaration: ProviderRuntimeDeclaration,
}

/// Normalized block reason when an authorized candidate exists but cannot be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DefaultActivationBlock {
  pub code: String,
  pub message: String,
}

/// Exact-policy provider default resolution for package-first create.
#[derive(Debug, Clone)]
pub(crate) enum ProviderDefaultResolution {
  Applicable(PreparedProviderDefault),
  NoApplicableDefault,
  Blocked(DefaultActivationBlock),
}

pub(crate) const AMBIGUOUS_AUTHORIZED_DEFAULT_CODE: &str = "ambiguous_authorized_default";
pub(crate) const AUTHORITY_EXPANSION_BLOCKED_CODE: &str = "authority_expansion_blocked";

/// Provider runtime lifecycle: adapter-keyed preview/apply/rollback/detach against the
/// validated catalog, with provider `updated_at` CAS, package re-verification, exact
/// `GrantSubjectKind::ProviderInstance` grant bundles (one per
/// active Provider/package, shared by aliases), adapter-scoped identity-only snapshots, and
/// provider-scoped migrated snapshot-set restore. Provider Base URL, auth scheme, proxy mode,
/// and credential storage remain in the existing Provider row; they are never guest config.
#[derive(Clone)]
pub struct ProviderRuntimeService {
  db: Database,
  catalog: std::sync::Arc<PluginCatalog>,
  wasm: Arc<WasmRuntime>,
  provider_catalog: Arc<ProviderRuntimeCatalog>,
  attach_previews: Arc<Mutex<HashMap<String, ProviderInterfaceAttachPreviewSession>>>,
  rollback_previews: Arc<Mutex<HashMap<String, ProviderInterfaceRollbackPreviewSession>>>,
}

impl ProviderRuntimeService {
  pub fn new(db: Database, catalog: std::sync::Arc<PluginCatalog>, wasm: Arc<WasmRuntime>) -> Self {
    let provider_catalog = Arc::new(ProviderRuntimeCatalog::new(db.clone(), catalog.clone(), wasm.clone()));
    Self {
      db,
      catalog,
      wasm,
      provider_catalog,
      attach_previews: Arc::new(Mutex::new(HashMap::new())),
      rollback_previews: Arc::new(Mutex::new(HashMap::new())),
    }
  }

  /// Public catalog command contract.
  pub fn list_catalog(&self) -> Result<Vec<ProviderRuntimeCatalogEntryDto>, StorageError> {
    self.provider_catalog.list()
  }

  /// Activate the pending catalog-default binding for one provider API type.
  ///
  /// This is the only default authority: the catalog default supplies the exact digest. Existing
  /// bindings that are already active are left untouched.
  pub fn activate_with_catalog_default(&self, provider_id: Uuid, adapter_id: &str) -> Result<(), StorageError> {
    let (provider, binding, content) = self.db.read(|conn| {
      let provider = provider_instances::get(conn, provider_id)?;
      let binding = provider_runtime_bindings::get(conn, provider_id, adapter_id)?;
      let digest = binding
        .package_digest
        .clone()
        .ok_or_else(|| StorageError::PluginUnavailable("provider runtime binding has no package digest".into()))?;
      let content = crate::services::plugin_catalog::resolve_pinned_content(Some(&self.catalog), conn, &digest)?
        .ok_or_else(|| StorageError::PluginUnavailable(format!("provider runtime package {digest} is unavailable")))?;
      Ok((provider, binding, content))
    })?;
    if binding.state == crate::domain::runtime_provider::ProviderRuntimeState::Active
      && binding.grant_set_revision.is_some()
    {
      return Ok(());
    }
    let declaration =
      content.manifest.provider_runtime.clone().ok_or_else(|| {
        StorageError::Validation("provider runtime package has no providerRuntime declaration".into())
      })?;
    let revision = self.db.read(|conn| {
      plugin_permission_grants::next_revision_for_subject_package(
        conn,
        GrantSubjectKind::ProviderInstance,
        provider_id,
        &content.content_digest,
      )
    })?;
    let bundle = build_provider_grant_bundle(provider_id, &content, &declaration, revision, &provider.base_url)?;
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      plugin_permission_grants::insert_bundle(uow.conn(), &bundle)?;
      let next = crate::domain::runtime_provider::ProviderRuntimeBinding {
        provider_id,
        adapter_id: adapter_id.to_string(),
        runtime_kind: crate::domain::runtime_provider::ProviderRuntimeKind::WasmComponent,
        package_digest: Some(content.content_digest.clone()),
        grant_set_revision: Some(bundle.header.revision),
        state: crate::domain::runtime_provider::ProviderRuntimeState::Active,
        error_code: None,
        error_message: None,
        runtime_requirement_json: binding.runtime_requirement_json.clone(),
        created_at: binding.created_at.clone(),
        updated_at: now.clone(),
      };
      provider_runtime_bindings::compare_and_set_pending_activation(
        uow.conn(),
        provider_id,
        adapter_id,
        &content.content_digest,
        crate::domain::runtime_provider::ProviderRuntimeState::PendingActivation,
        &binding.updated_at,
        &next,
      )
    })?;
    Ok(())
  }

  pub(crate) fn resolve_applicable_provider_default(
    &self,
    input: &ProviderInstanceWrite,
  ) -> Result<ProviderDefaultResolution, StorageError> {
    // Connection requirements must match the catalog default destination: plugin-default
    // destination, inherited proxy, no insecure-HTTP confirmation. A mismatch is a blocked
    // authority expansion, never a silent fallback.
    let connection_matches_default = input.base_url_source == BaseUrlSource::PluginDefault
      && input.proxy_mode == ProxyMode::Inherit
      && input.insecure_http_confirmed_at.is_none();

    let mut ready: Vec<PreparedProviderDefault> = Vec::new();
    for descriptor in self.catalog.descriptors() {
      let Some(loaded) = self.catalog.snapshot_optional(&descriptor.content_digest) else {
        continue;
      };
      let Some(declaration) = loaded.manifest.provider_runtime.clone() else {
        continue;
      };
      if !declaration
        .legacy_aliases
        .iter()
        .any(|alias| alias == &input.adapter_id)
      {
        continue;
      }
      // Only the resolved catalog default for this plugin is applicable.
      if self.catalog.default_digest(&descriptor.plugin_id).as_deref() != Some(descriptor.content_digest.as_str()) {
        continue;
      }
      if !connection_matches_default {
        return Ok(ProviderDefaultResolution::Blocked(DefaultActivationBlock {
          code: AUTHORITY_EXPANSION_BLOCKED_CODE.into(),
          message: format!(
            "provider connection requirements expand beyond the catalog default for {}",
            descriptor.plugin_id
          ),
        }));
      }
      ready.push(PreparedProviderDefault {
        content: PinnedContent {
          content_digest: loaded.descriptor.content_digest.clone(),
          plugin_id: loaded.descriptor.plugin_id.clone(),
          version: loaded.descriptor.version.clone(),
          manifest_json: loaded.manifest_json.clone(),
          manifest: loaded.manifest.clone(),
          runtime_kind: loaded.descriptor.runtime_kind,
          source: loaded.descriptor.source,
        },
        declaration,
      });
    }

    match ready.len() {
      0 => Ok(ProviderDefaultResolution::NoApplicableDefault),
      1 => Ok(ProviderDefaultResolution::Applicable(ready.remove(0))),
      _ => Ok(ProviderDefaultResolution::Blocked(DefaultActivationBlock {
        code: AMBIGUOUS_AUTHORIZED_DEFAULT_CODE.into(),
        message: "multiple catalog defaults declare the same provider adapter".into(),
      })),
    }
  }

  /// Preview attaching or replacing ONE API type binding with an exact package. The
  /// requested adapter must be declared by the package; a second package claiming an already
  /// attached API type is a conflict; a second declared alias of an already attached package
  /// reuses the exact Provider/package grant.
  pub fn preview_interface_attach(
    &self,
    input: &PreviewProviderRuntimeInterfaceAttachInput,
  ) -> Result<ProviderRuntimeInterfacePreviewDto, StorageError> {
    self.expire_previews();
    let adapter_id = input.adapter_id.trim().to_string();
    if adapter_id.is_empty() {
      return Err(StorageError::Validation("adapter_id must not be empty".into()));
    }
    validate_adapter_id(&adapter_id).map_err(StorageError::Validation)?;
    let now = now_rfc3339();
    let (provider, current) = self.db.read(|conn| {
      let provider = provider_instances::get(conn, input.provider_id)?;
      let current = provider_runtime_bindings::get_optional(conn, input.provider_id, &adapter_id)?;
      Ok((provider, current))
    })?;
    let version = self.catalog.snapshot(&input.package_digest).map_err(|_| {
      StorageError::PluginUnavailable(format!(
        "provider runtime package {} is not installed",
        input.package_digest
      ))
    })?;
    let (manifest, declaration) = {
      let PackageVerification::ProviderRuntime(_, manifest, declaration) =
        self.provider_catalog.verify_package(&version)?
      else {
        return Err(StorageError::Validation(format!(
          "package {} is not a provider runtime package",
          version.descriptor.plugin_id
        )));
      };
      (manifest, declaration)
    };
    if !declaration.legacy_aliases.iter().any(|alias| alias == &adapter_id) {
      return Err(StorageError::Validation(format!(
        "API type '{adapter_id}' is absent from the package declaration"
      )));
    }
    if current
      .as_ref()
      .map(|binding| {
        binding.runtime_kind == ProviderRuntimeKind::WasmComponent
          && binding.package_digest.as_deref() == Some(input.package_digest.as_str())
      })
      .unwrap_or(false)
    {
      return Err(StorageError::Conflict(format!(
        "API type '{adapter_id}' is already attached to package {}",
        input.package_digest
      )));
    }

    let (grant_bundle, grant_revision) = if self
      .db
      .read(|conn| provider_runtime_bindings::has_active_package(conn, input.provider_id, &input.package_digest))?
    {
      // Alias reuse: the Provider already holds the exact Provider/package grant.
      let revision = self.db.read(|conn| {
        provider_runtime_bindings::list_by_provider(conn, input.provider_id)?
          .into_iter()
          .find(|binding| {
            binding.package_digest.as_deref() == Some(input.package_digest.as_str())
              && binding.state == ProviderRuntimeState::Active
          })
          .and_then(|binding| binding.grant_set_revision)
          .ok_or_else(|| StorageError::Internal("active package binding is missing its grant revision".into()))
      })?;
      (None, revision)
    } else {
      let revision = self.db.read(|conn| {
        plugin_permission_grants::next_revision_for_subject_package(
          conn,
          GrantSubjectKind::ProviderInstance,
          input.provider_id,
          &input.package_digest,
        )
      })?;
      let provider_base_url = self
        .db
        .read(|conn| provider_instances::get(conn, input.provider_id).map(|provider| provider.base_url))?;
      let content = PinnedContent {
        content_digest: version.descriptor.content_digest.clone(),
        plugin_id: version.descriptor.plugin_id.clone(),
        version: version.descriptor.version.clone(),
        manifest_json: version.manifest_json.clone(),
        manifest: manifest.clone(),
        runtime_kind: version.descriptor.runtime_kind,
        source: version.descriptor.source,
      };
      let bundle =
        build_provider_grant_bundle(input.provider_id, &content, &declaration, revision, &provider_base_url)?;
      (Some(bundle), revision)
    };

    // Adapter-scoped identity-only snapshot of the current binding. A never-attached adapter
    // snapshots an absent identity (no package digest) so rollback restores "no binding".
    // The snapshot identity resolves from the SOURCE binding's digest — never the target
    // package's identity.
    let source = current.clone().unwrap_or_else(|| ProviderRuntimeBinding {
      provider_id: input.provider_id,
      adapter_id: adapter_id.clone(),
      runtime_kind: ProviderRuntimeKind::WasmComponent,
      package_digest: None,
      grant_set_revision: None,
      state: ProviderRuntimeState::Unavailable,
      error_code: None,
      error_message: None,
      runtime_requirement_json: None,
      created_at: now.clone(),
      updated_at: now.clone(),
    });
    let (source_plugin_id, source_plugin_version, source_api) = self
      .db
      .read(|conn| snapshot_source_identity(&self.catalog, conn, &source))?;
    let snapshot_id = new_id();
    let snapshot = ProviderRuntimeSnapshotSet {
      id: snapshot_id,
      provider_id: input.provider_id,
      scope: ProviderRuntimeSnapshotScope::Adapter,
      created_at: now.clone(),
      discarded_at: None,
      runtime_kind: source.runtime_kind,
      package_digest: source.package_digest.clone(),
      grant_set_revision: source.grant_set_revision,
      grant_set_id: None,
      plugin_id: source_plugin_id,
      plugin_version: source_plugin_version,
      plugin_api_version: source_api,
      capability_ids_json: serde_json::to_string(&REQUIRED_LLM_CAPABILITIES).unwrap_or_default(),
      updated_at: now.clone(),
    };
    let snapshot_child = ProviderRuntimeSnapshotBinding {
      id: new_id(),
      snapshot_set_id: snapshot_id,
      provider_id: input.provider_id,
      adapter_id: adapter_id.clone(),
      runtime_kind: source.runtime_kind,
      package_digest: source.package_digest.clone(),
      grant_set_revision: source.grant_set_revision,
      state: source.state,
      error_code: source.error_code.clone(),
      error_message: source.error_message.clone(),
      runtime_requirement_json: source.runtime_requirement_json.clone(),
      created_at: source.created_at.clone(),
      updated_at: now.clone(),
    };

    let source_dto = ProviderRuntimeBindingDto::from(&source);
    let preview_id = new_id().to_string();
    let expires_at = Instant::now() + Duration::from_secs(RUNTIME_PREVIEW_TTL_SECS);
    self.attach_previews.lock().unwrap_or_else(|e| e.into_inner()).insert(
      preview_id.clone(),
      ProviderInterfaceAttachPreviewSession {
        preview_id: preview_id.clone(),
        provider_id: input.provider_id,
        adapter_id: adapter_id.clone(),
        expected_updated_at: provider.updated_at.clone(),
        source_row_present: current.is_some(),
        source,
        target_package_digest: input.package_digest.clone(),
        target_plugin_id: version.descriptor.plugin_id.clone(),
        target_plugin_version: version.descriptor.version.clone(),
        target_legacy_aliases: declaration.legacy_aliases.clone(),
        grant_bundle,
        grant_revision,
        snapshot,
        snapshot_child,
        requires_permission_approval: true,
        expires_at,
      },
    );
    let target = ProviderRuntimeBindingDto {
      adapter_id: adapter_id.clone(),
      runtime_kind: ProviderRuntimeKind::WasmComponent,
      package_digest: Some(input.package_digest.clone()),
      grant_set_revision: Some(grant_revision),
      state: ProviderRuntimeState::Active,
      error_code: None,
      error_message: None,
      updated_at: now,
    };
    Ok(ProviderRuntimeInterfacePreviewDto {
      preview_id,
      provider_id: input.provider_id,
      adapter_id,
      source: source_dto,
      target,
      target_plugin_version: version.descriptor.version.clone(),
      legacy_aliases: declaration.legacy_aliases.clone(),
      requires_permission_approval: true,
      expires_at: format_rfc3339(expires_at),
    })
  }

  /// Apply one previewed interface attach/replace atomically, or change nothing.
  pub fn apply_interface_attach(
    &self,
    input: ApplyProviderRuntimeInterfaceAttachInput,
  ) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, StorageError> {
    self.expire_previews();
    let session = {
      let mut guard = self.attach_previews.lock().unwrap_or_else(|e| e.into_inner());
      guard
        .remove(&input.preview_id)
        .ok_or_else(|| StorageError::Conflict("provider runtime interface preview is missing or expired".into()))?
    };
    if Instant::now() > session.expires_at {
      return Err(StorageError::Conflict(
        "provider runtime interface preview expired".into(),
      ));
    }
    if session.requires_permission_approval && !input.acknowledge_permissions {
      return Err(StorageError::Validation(
        "provider runtime interface attach requires acknowledgePermissions".into(),
      ));
    }

    let now = now_rfc3339();
    let (provider, binding) = self.db.transaction(|uow| {
      let conn = uow.conn();
      let provider = provider_instances::get(conn, session.provider_id)?;
      if provider.updated_at != session.expected_updated_at {
        return Err(StorageError::Conflict(
          "provider changed concurrently; re-preview before applying".into(),
        ));
      }
      let current = provider_runtime_bindings::get_optional(conn, session.provider_id, &session.adapter_id)?;
      if session.source_row_present {
        if current.as_ref() != Some(&session.source) {
          return Err(StorageError::Conflict(
            "provider runtime interface pin changed concurrently".into(),
          ));
        }
      } else if current.is_some() {
        return Err(StorageError::Conflict(
          "provider runtime interface pin changed concurrently".into(),
        ));
      }
      // Re-verify the package through the immutable catalog snapshot inside the apply transaction.
      let version = self.catalog.snapshot(&session.target_package_digest).map_err(|_| {
        StorageError::PluginUnavailable(format!(
          "provider runtime package {} is not installed",
          session.target_package_digest
        ))
      })?;
      let PackageVerification::ProviderRuntime(_, _manifest, declaration) =
        self.provider_catalog.verify_package(&version)?
      else {
        return Err(StorageError::Validation(format!(
          "provider runtime package {} is not a provider runtime package",
          version.descriptor.plugin_id
        )));
      };
      if !declaration
        .legacy_aliases
        .iter()
        .any(|alias| alias == &session.adapter_id)
      {
        return Err(StorageError::Validation(format!(
          "API type '{}' is absent from the package declaration",
          session.adapter_id
        )));
      }
      if let Some(bundle) = &session.grant_bundle {
        if bundle.header.package_digest != session.target_package_digest
          || bundle.header.plugin_id != version.descriptor.plugin_id
          || bundle.header.plugin_version != version.descriptor.version
        {
          return Err(StorageError::Conflict(
            "grant bundle identity diverged from the target package; re-preview required".into(),
          ));
        }
        // One current grant-set revision per provider/package: refuse to double-bind.
        if plugin_permission_grants::get_for_subject_package_revision(
          conn,
          GrantSubjectKind::ProviderInstance,
          session.provider_id,
          &session.target_package_digest,
          session
            .grant_bundle
            .as_ref()
            .map(|b| b.header.revision)
            .unwrap_or(session.grant_revision),
        )
        .is_ok()
        {
          return Err(StorageError::Conflict(
            "provider execution grant already exists for this package revision".into(),
          ));
        }
        plugin_permission_grants::insert_bundle(conn, bundle)?;
      }
      provider_runtime_bindings::insert_snapshot_set(conn, &session.snapshot)?;
      provider_runtime_bindings::insert_snapshot_binding(conn, &session.snapshot_child)?;
      let binding = ProviderRuntimeBinding {
        provider_id: session.provider_id,
        adapter_id: session.adapter_id.clone(),
        runtime_kind: ProviderRuntimeKind::WasmComponent,
        package_digest: Some(session.target_package_digest.clone()),
        grant_set_revision: Some(session.grant_revision),
        state: ProviderRuntimeState::Active,
        error_code: None,
        error_message: None,
        runtime_requirement_json: None,
        created_at: session.source.created_at.clone(),
        updated_at: now.clone(),
      };
      if session.source_row_present {
        provider_runtime_bindings::update(conn, &binding)?;
      } else {
        provider_runtime_bindings::insert(conn, &binding)?;
      }
      Ok((provider, binding))
    })?;
    Ok(ProviderRuntimeInterfaceLifecycleResultDto {
      provider_id: provider.id,
      adapter_id: session.adapter_id,
      binding: ProviderRuntimeBindingDto::from(&binding),
      updated_at: binding.updated_at,
    })
  }

  /// Preview rolling ONE API type binding back. Adapter-scoped snapshots restore their own
  /// child; a migrated v24 Provider-scoped snapshot restores the whole Provider atomically.
  pub fn preview_interface_rollback(
    &self,
    input: &PreviewProviderRuntimeInterfaceRollbackInput,
  ) -> Result<ProviderRuntimeInterfaceRollbackPreviewDto, StorageError> {
    self.expire_previews();
    let adapter_id = input.adapter_id.trim().to_string();
    if adapter_id.is_empty() {
      return Err(StorageError::Validation("adapter_id must not be empty".into()));
    }
    let (provider, current, snapshots) = self.db.read(|conn| {
      let provider = provider_instances::get(conn, input.provider_id)?;
      let current = provider_runtime_bindings::get(conn, input.provider_id, &adapter_id)?;
      if current.runtime_kind != ProviderRuntimeKind::WasmComponent {
        return Err(StorageError::Validation(
          "provider has no runtime package binding for this API type to roll back".into(),
        ));
      }
      let sets = provider_runtime_bindings::list_snapshot_sets(conn, input.provider_id)?;
      Ok((provider, current, sets))
    })?;
    // Newest undiscarded adapter-scoped set owning this API type wins; otherwise fall back to
    // the newest undiscarded migrated Provider-scoped set (atomic whole-Provider restore).
    let mut matched: Option<(Uuid, ProviderRuntimeSnapshotScope)> = None;
    for set in &snapshots {
      if set.scope == ProviderRuntimeSnapshotScope::Adapter {
        let children = self
          .db
          .read(|conn| provider_runtime_bindings::list_snapshot_bindings(conn, set.id))?;
        if children.iter().any(|child| child.adapter_id == adapter_id) {
          matched = Some((set.id, set.scope));
          break;
        }
      }
    }
    if matched.is_none() {
      matched = snapshots
        .iter()
        .find(|set| set.scope == ProviderRuntimeSnapshotScope::Provider)
        .map(|set| (set.id, set.scope));
    }
    let (snapshot_id, scope) =
      matched.ok_or_else(|| StorageError::Validation("provider has no rollback snapshot for this API type".into()))?;
    let target = if scope == ProviderRuntimeSnapshotScope::Adapter {
      let children = self
        .db
        .read(|conn| provider_runtime_bindings::list_snapshot_bindings(conn, snapshot_id))?;
      let child = children
        .into_iter()
        .find(|child| child.adapter_id == adapter_id)
        .ok_or_else(|| StorageError::Internal("adapter snapshot has no matching child".into()))?;
      ProviderRuntimeBindingDto {
        adapter_id: child.adapter_id,
        runtime_kind: child.runtime_kind,
        package_digest: child.package_digest,
        grant_set_revision: child.grant_set_revision,
        state: child.state,
        error_code: child.error_code,
        error_message: child.error_message,
        updated_at: child.updated_at,
      }
    } else {
      // Provider-scoped restore: project the effective default binding after the atomic
      // replace (children plus a legacy default row when absent). Fail closed when the
      // migrated snapshot predates the REQUESTED API type: a whole-Provider restore would
      // silently drop that binding and then fail with NotFound. Only the Provider default
      // API type has a defined legacy fallback when the snapshot omits it.
      let children = self
        .db
        .read(|conn| provider_runtime_bindings::list_snapshot_bindings(conn, snapshot_id))?;
      if !children.iter().any(|child| child.adapter_id == adapter_id) && adapter_id != provider.adapter_id {
        return Err(StorageError::Validation(format!(
          "provider rollback snapshot does not include API type '{adapter_id}'; the snapshot predates this interface"
        )));
      }
      let default_adapter = provider.adapter_id.clone();
      if let Some(child) = children.iter().find(|child| child.adapter_id == default_adapter) {
        ProviderRuntimeBindingDto {
          adapter_id: child.adapter_id.clone(),
          runtime_kind: child.runtime_kind,
          package_digest: child.package_digest.clone(),
          grant_set_revision: child.grant_set_revision,
          state: child.state,
          error_code: child.error_code.clone(),
          error_message: child.error_message.clone(),
          updated_at: child.updated_at.clone(),
        }
      } else {
        // Package-only: the default API type without a snapshot child has no binding at all.
        ProviderRuntimeBindingDto::from(&ProviderRuntimeBinding {
          provider_id: input.provider_id,
          adapter_id: default_adapter.clone(),
          runtime_kind: ProviderRuntimeKind::WasmComponent,
          package_digest: None,
          grant_set_revision: None,
          state: ProviderRuntimeState::Unavailable,
          error_code: Some("no_runtime_binding".into()),
          error_message: None,
          runtime_requirement_json: None,
          created_at: now_rfc3339(),
          updated_at: now_rfc3339(),
        })
      }
    };
    let current_dto = ProviderRuntimeBindingDto::from(&current);
    let preview_id = new_id().to_string();
    let expires_at = Instant::now() + Duration::from_secs(RUNTIME_PREVIEW_TTL_SECS);
    self.rollback_previews.lock().unwrap_or_else(|e| e.into_inner()).insert(
      preview_id.clone(),
      ProviderInterfaceRollbackPreviewSession {
        preview_id: preview_id.clone(),
        provider_id: input.provider_id,
        adapter_id: adapter_id.clone(),
        expected_updated_at: provider.updated_at.clone(),
        current,
        snapshot_set_id: snapshot_id,
        snapshot_scope: scope,
        expires_at,
      },
    );
    Ok(ProviderRuntimeInterfaceRollbackPreviewDto {
      preview_id,
      provider_id: input.provider_id,
      adapter_id,
      snapshot_id,
      snapshot_scope: scope.as_str().to_string(),
      current: current_dto,
      target,
      expires_at: format_rfc3339(expires_at),
    })
  }

  /// Apply one previewed interface rollback atomically, restoring the exact snapshot identity.
  pub fn apply_interface_rollback(
    &self,
    input: ApplyProviderRuntimeInterfaceRollbackInput,
  ) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, StorageError> {
    self.expire_previews();
    let session = {
      let mut guard = self.rollback_previews.lock().unwrap_or_else(|e| e.into_inner());
      guard.remove(&input.preview_id).ok_or_else(|| {
        StorageError::Conflict("provider runtime interface rollback preview is missing or expired".into())
      })?
    };
    if Instant::now() > session.expires_at {
      return Err(StorageError::Conflict(
        "provider runtime interface rollback preview expired".into(),
      ));
    }
    let now = now_rfc3339();
    let (provider, binding) = self.db.transaction(|uow| {
      let conn = uow.conn();
      let provider = provider_instances::get(conn, session.provider_id)?;
      if provider.updated_at != session.expected_updated_at {
        return Err(StorageError::Conflict(
          "provider changed concurrently; re-preview before rolling back".into(),
        ));
      }
      let current = provider_runtime_bindings::get(conn, session.provider_id, &session.adapter_id)?;
      if current != session.current {
        return Err(StorageError::Conflict(
          "provider runtime interface pin changed concurrently".into(),
        ));
      }
      let set = provider_runtime_bindings::get_snapshot_set(conn, session.snapshot_set_id)?
        .ok_or_else(|| StorageError::Conflict("rollback snapshot is missing".into()))?;
      if set.discarded_at.is_some() {
        return Err(StorageError::Conflict("rollback snapshot was already discarded".into()));
      }
      // Every binding removed by this restore (adapter scope: the rolled-back row;
      // Provider scope: every pre-restore row) is collected for reference-aware grant release.
      let mut replaced: Vec<ProviderRuntimeBinding> = Vec::new();
      let restored: Result<(ProviderInstance, ProviderRuntimeBinding), StorageError> = match session.snapshot_scope {
        ProviderRuntimeSnapshotScope::Adapter => {
          let children = provider_runtime_bindings::list_snapshot_bindings(conn, session.snapshot_set_id)?;
          let child = children
            .into_iter()
            .find(|child| child.adapter_id == session.adapter_id)
            .ok_or_else(|| StorageError::Internal("adapter snapshot has no matching child".into()))?;
          restore_adapter_binding(conn, &provider, &child, &now)?;
          // A never-attached non-default adapter returns to "no row" (legacy execution);
          // the result DTO projects the restored identity.
          let restored = provider_runtime_bindings::get_optional(conn, session.provider_id, &session.adapter_id)?
            .unwrap_or_else(|| child_binding(&child, &now));
          replaced.push(current.clone());
          Ok((provider, restored))
        }
        ProviderRuntimeSnapshotScope::Provider => {
          // Atomic whole-Provider restore: replace every binding with the set children and
          // guarantee the Provider default API type keeps a legacy row. Every replaced
          // binding is collected so its package grant can be released reference-aware.
          let children = provider_runtime_bindings::list_snapshot_bindings(conn, session.snapshot_set_id)?;
          // Fail closed BEFORE deleting anything: the preview guarantees the requested
          // adapter is restorable; a stale session must never delete-then-NotFound.
          if !children.iter().any(|child| child.adapter_id == session.adapter_id)
            && session.adapter_id != provider.adapter_id
          {
            return Err(StorageError::Validation(format!(
              "provider rollback snapshot does not include API type '{}'",
              session.adapter_id
            )));
          }
          let existing = provider_runtime_bindings::list_by_provider(conn, session.provider_id)?;
          for existing_binding in &existing {
            provider_runtime_bindings::delete(conn, session.provider_id, &existing_binding.adapter_id)?;
            replaced.push(existing_binding.clone());
          }
          for child in &children {
            provider_runtime_bindings::insert(conn, &child_binding(child, &now))?;
          }
          // Package-only: no legacy fallback row exists for the default API type. A snapshot
          // without the default adapter keeps the type unbound until the user attaches it.
          Ok((
            provider,
            provider_runtime_bindings::get(conn, session.provider_id, &session.adapter_id)?,
          ))
        }
      };
      // Discard the consumed set inside the same transaction, then release every replaced
      // binding's grant whose final reference disappeared with the restore.
      let (provider, binding) = restored.and_then(|(provider, binding)| {
        provider_runtime_bindings::discard_snapshot_set(conn, session.snapshot_set_id, &now)?;
        Ok((provider, binding))
      })?;
      for replaced_binding in &replaced {
        release_grant_after_removal(conn, session.provider_id, replaced_binding)?;
      }
      Ok((provider, binding))
    })?;
    Ok(ProviderRuntimeInterfaceLifecycleResultDto {
      provider_id: provider.id,
      adapter_id: session.adapter_id,
      binding: ProviderRuntimeBindingDto::from(&binding),
      updated_at: binding.updated_at,
    })
  }

  /// Detach ONE API type binding directly (CAS on the provider version). The removed route
  /// becomes an adapter-scoped rollback snapshot so the user can undo; the exact
  /// Provider/package grant is released only after no active alias row or undiscarded
  /// snapshot set references it.
  pub fn detach_interface(
    &self,
    input: &ProviderRuntimeInterfaceDetachInput,
  ) -> Result<ProviderRuntimeInterfaceLifecycleResultDto, StorageError> {
    let adapter_id = input.adapter_id.trim().to_string();
    if adapter_id.is_empty() {
      return Err(StorageError::Validation("adapter_id must not be empty".into()));
    }
    let now = now_rfc3339();
    let (provider, binding) = self.db.transaction(|uow| {
      let conn = uow.conn();
      let provider = provider_instances::get(conn, input.provider_id)?;
      if provider.updated_at != input.expected_updated_at {
        return Err(StorageError::Conflict(
          "provider changed concurrently; reload before detaching".into(),
        ));
      }
      let current = provider_runtime_bindings::get(conn, input.provider_id, &adapter_id)?;
      if current.updated_at != input.expected_binding_updated_at {
        return Err(StorageError::Conflict(
          "provider runtime interface pin changed concurrently; reload before detaching".into(),
        ));
      }
      if current.runtime_kind != ProviderRuntimeKind::WasmComponent {
        return Err(StorageError::Validation(
          "provider has no runtime package binding for this API type to detach".into(),
        ));
      }
      // Identity-only adapter snapshot of the removed route, resolved from the removed
      // binding's exact package identity (never the digest as plugin_id).
      let set_id = new_id();
      let (source_plugin_id, source_plugin_version, source_api) =
        snapshot_source_identity(&self.catalog, conn, &current)?;
      provider_runtime_bindings::insert_snapshot_set(
        conn,
        &ProviderRuntimeSnapshotSet {
          id: set_id,
          provider_id: input.provider_id,
          scope: ProviderRuntimeSnapshotScope::Adapter,
          created_at: now.clone(),
          discarded_at: None,
          runtime_kind: current.runtime_kind,
          package_digest: current.package_digest.clone(),
          grant_set_revision: current.grant_set_revision,
          grant_set_id: None,
          plugin_id: source_plugin_id,
          plugin_version: source_plugin_version,
          plugin_api_version: source_api,
          capability_ids_json: serde_json::to_string(&REQUIRED_LLM_CAPABILITIES).unwrap_or_default(),
          updated_at: now.clone(),
        },
      )?;
      provider_runtime_bindings::insert_snapshot_binding(
        conn,
        &ProviderRuntimeSnapshotBinding {
          id: new_id(),
          snapshot_set_id: set_id,
          provider_id: input.provider_id,
          adapter_id: adapter_id.clone(),
          runtime_kind: current.runtime_kind,
          package_digest: current.package_digest.clone(),
          grant_set_revision: current.grant_set_revision,
          state: current.state,
          error_code: current.error_code.clone(),
          error_message: current.error_message.clone(),
          runtime_requirement_json: current.runtime_requirement_json.clone(),
          created_at: current.created_at.clone(),
          updated_at: now.clone(),
        },
      )?;
      // Package-only: detaching any API type removes its binding row; there is no legacy
      // fallback row.
      provider_runtime_bindings::delete(conn, input.provider_id, &adapter_id)?;
      release_grant_after_removal(conn, input.provider_id, &current)?;
      let binding = ProviderRuntimeBinding {
        provider_id: input.provider_id,
        adapter_id: adapter_id.clone(),
        runtime_kind: ProviderRuntimeKind::WasmComponent,
        package_digest: None,
        grant_set_revision: None,
        state: ProviderRuntimeState::Unavailable,
        error_code: Some("no_runtime_binding".into()),
        error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now.clone(),
      };
      Ok((provider, binding))
    })?;
    Ok(ProviderRuntimeInterfaceLifecycleResultDto {
      provider_id: provider.id,
      adapter_id,
      binding: ProviderRuntimeBindingDto::from(&binding),
      updated_at: binding.updated_at,
    })
  }

  /// List undiscarded rollback snapshot sets for one provider (newest first) as sanitized
  /// DTOs. This is the frontend-reachable cleanup seam for attach/replace/detach snapshots:
  /// each set retains the prior package grant, and discarding the final reference releases
  /// it so the package can be uninstalled. Rollback stays possible until the discard.
  pub fn list_interface_snapshots(&self, provider_id: Uuid) -> Result<Vec<ProviderRuntimeSnapshotDto>, StorageError> {
    self.db.read(|conn| {
      let sets = provider_runtime_bindings::list_snapshot_sets(conn, provider_id)?;
      let mut dtos = Vec::with_capacity(sets.len());
      for set in sets {
        let children = provider_runtime_bindings::list_snapshot_bindings(conn, set.id)?;
        dtos.push(ProviderRuntimeSnapshotDto {
          id: set.id,
          provider_id: set.provider_id,
          scope: set.scope.as_str().to_string(),
          created_at: set.created_at,
          plugin_id: set.plugin_id,
          plugin_version: set.plugin_version,
          package_digest: set.package_digest,
          adapter_ids: children.into_iter().map(|child| child.adapter_id).collect(),
        });
      }
      Ok(dtos)
    })
  }

  /// Discard one undiscarded rollback snapshot set (CAS on the provider version). Releasing
  /// the final snapshot releases the retained Provider/package grant.
  pub fn discard_interface_snapshot(
    &self,
    input: &ProviderRuntimeInterfaceDiscardSnapshotInput,
  ) -> Result<(), StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      let conn = uow.conn();
      let provider = provider_instances::get(conn, input.provider_id)?;
      if provider.updated_at != input.expected_updated_at {
        return Err(StorageError::Conflict(
          "provider changed concurrently; reload before discarding".into(),
        ));
      }
      let set = provider_runtime_bindings::get_snapshot_set(conn, input.snapshot_id)?
        .ok_or_else(|| StorageError::NotFound(format!("provider runtime snapshot {}", input.snapshot_id)))?;
      if set.provider_id != input.provider_id {
        return Err(StorageError::Validation(
          "snapshot does not belong to this provider".into(),
        ));
      }
      if set.discarded_at.is_some() {
        return Err(StorageError::Conflict("rollback snapshot was already discarded".into()));
      }
      let grant = (set.package_digest.clone(), set.grant_set_revision);
      provider_runtime_bindings::discard_snapshot_set(conn, input.snapshot_id, &now)?;
      if let (Some(package_digest), Some(revision)) = grant {
        release_provider_grant(conn, input.provider_id, &package_digest, revision)?;
      }
      Ok(())
    })
  }

  /// Compatibility wrapper (legacy command): preview rolling the Provider default API type
  /// binding back.
  pub fn preview_rollback(&self, provider_id: Uuid) -> Result<ProviderRuntimeRollbackPreviewDto, StorageError> {
    let adapter_id = self
      .db
      .read(|conn| provider_instances::get(conn, provider_id))?
      .adapter_id;
    let preview = self.preview_interface_rollback(&PreviewProviderRuntimeInterfaceRollbackInput {
      provider_id,
      adapter_id: adapter_id.clone(),
    })?;
    Ok(ProviderRuntimeRollbackPreviewDto {
      preview_id: preview.preview_id,
      provider_id: preview.provider_id,
      snapshot_id: preview.snapshot_id,
      current: preview.current,
      target: preview.target,
      expires_at: preview.expires_at,
    })
  }

  /// Compatibility wrapper (legacy command): apply one previewed default-API-type rollback.
  pub fn apply_rollback(
    &self,
    input: ApplyProviderRuntimeRollbackInput,
  ) -> Result<ProviderRuntimeLifecycleResultDto, StorageError> {
    let result = self.apply_interface_rollback(ApplyProviderRuntimeInterfaceRollbackInput {
      preview_id: input.preview_id,
    })?;
    Ok(ProviderRuntimeLifecycleResultDto {
      provider_id: result.provider_id,
      runtime: result.binding,
      updated_at: result.updated_at,
    })
  }

  /// Drop expired preview sessions (bounded memory; TTL mirrors Phase 4 lifecycle previews).
  fn expire_previews(&self) {
    let now = Instant::now();
    if let Ok(mut guard) = self.attach_previews.lock() {
      guard.retain(|_, session| session.expires_at > now);
    }
    if let Ok(mut guard) = self.rollback_previews.lock() {
      guard.retain(|_, session| session.expires_at > now);
    }
  }
}

/// Resolve the identity-only snapshot record of a SOURCE binding: package-backed bindings
/// reverse-bind their exact installed plugin/version/API identity from the digest;
/// legacy bindings carry the explicit legacy sentinel identity. A digest is never stored as
/// `plugin_id`, and the target package's identity never leaks into a source snapshot.
fn snapshot_source_identity(
  catalog: &PluginCatalog,
  conn: &rusqlite::Connection,
  source: &ProviderRuntimeBinding,
) -> Result<(String, String, Option<String>), StorageError> {
  let Some(digest) = source.package_digest.as_deref().filter(|value| !value.is_empty()) else {
    // Absent/unresolved source: snapshot empty identity so rollback restores no binding.
    return Ok((String::new(), String::new(), None));
  };
  let content =
    crate::services::plugin_catalog::resolve_pinned_content(Some(catalog), conn, digest)?.ok_or_else(|| {
      StorageError::Internal(format!(
        "bound provider runtime package {digest} is missing from the catalog"
      ))
    })?;
  Ok((
    content.plugin_id,
    content.version,
    Some(content.manifest.plugin_api_version),
  ))
}

/// Restore ONE adapter binding from a snapshot child. A child without a package identity
/// (never-attached adapter) restores to "no binding": the row is removed.
fn restore_adapter_binding(
  conn: &rusqlite::Connection,
  provider: &ProviderInstance,
  child: &ProviderRuntimeSnapshotBinding,
  now: &str,
) -> Result<(), StorageError> {
  if child.package_digest.is_none() {
    let _ = provider_runtime_bindings::delete(conn, provider.id, &child.adapter_id);
    return Ok(());
  }
  let binding = child_binding(child, now);
  match provider_runtime_bindings::get_optional(conn, provider.id, &child.adapter_id)? {
    Some(_) => provider_runtime_bindings::update(conn, &binding),
    None => provider_runtime_bindings::insert(conn, &binding),
  }
}

/// Project a snapshot child into a current binding row.
fn child_binding(child: &ProviderRuntimeSnapshotBinding, now: &str) -> ProviderRuntimeBinding {
  ProviderRuntimeBinding {
    provider_id: child.provider_id,
    adapter_id: child.adapter_id.clone(),
    runtime_kind: child.runtime_kind,
    package_digest: child.package_digest.clone(),
    grant_set_revision: child.grant_set_revision,
    state: child.state,
    error_code: child.error_code.clone(),
    error_message: child.error_message.clone(),
    runtime_requirement_json: child.runtime_requirement_json.clone(),
    created_at: child.created_at.clone(),
    updated_at: now.to_string(),
  }
}

/// Release the exact Provider/package grant after a removal when no active binding row and no
/// undiscarded snapshot set still references it.
pub(crate) fn release_grant_after_removal(
  conn: &rusqlite::Connection,
  provider_id: Uuid,
  removed: &ProviderRuntimeBinding,
) -> Result<(), StorageError> {
  let Some(package_digest) = removed.package_digest.as_deref() else {
    return Ok(());
  };
  let Some(revision) = removed.grant_set_revision else {
    return Ok(());
  };
  release_provider_grant(conn, provider_id, package_digest, revision)
}

pub(crate) fn release_provider_grant(
  conn: &rusqlite::Connection,
  provider_id: Uuid,
  package_digest: &str,
  revision: u64,
) -> Result<(), StorageError> {
  if provider_runtime_bindings::has_active_package(conn, provider_id, package_digest)?
    || provider_runtime_bindings::provider_snapshot_references_grant(conn, provider_id, package_digest, revision)?
  {
    return Ok(());
  }
  plugin_permission_grants::delete_for_subject_package_revision(
    conn,
    GrantSubjectKind::ProviderInstance,
    provider_id,
    package_digest,
    revision,
  )
}

/// Build the exact provider-scoped execution grant bundle with provider-instance endpoint authority.
///
/// Network entries bind the normalized provider origin/base URL, closed auth policy, methods,
/// response modes, and resource limits. Credentials and credential references never appear.
fn build_provider_grant_bundle(
  provider_id: Uuid,
  content: &PinnedContent,
  declaration: &ProviderRuntimeDeclaration,
  revision: u64,
  provider_base_url: &str,
) -> Result<ExecutionGrantSetBundle, StorageError> {
  use crate::domain::plugin_resource::NetworkResponseBodyModes;
  use crate::domain::runtime_lifecycle::NetworkGrantEntryRecord;
  use crate::domain::runtime_plugin::{
    AuthPolicyId, EndpointId, HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID, HttpMethod, HttpsOrigin, NetworkGrantEntry,
    NetworkOriginKind, NetworkResourceMode, PROVIDER_RUNTIME_ENDPOINT_ID, ResourceLimits,
  };
  use crate::services::runtime_router::http_method_as_str;

  let grant_id = new_id();
  let mut capabilities = Vec::new();
  let mut domain_caps = Vec::new();
  let capability_ids: Vec<String> = declaration.capabilities.keys().cloned().collect();
  for capability_id in &capability_ids {
    capabilities.push(CapabilityGrantEntryRecord {
      id: new_id(),
      grant_set_id: grant_id,
      capability_id: capability_id.clone(),
    });
    domain_caps.push(CapabilityId::parse(capability_id).map_err(|e| StorageError::Validation(format!("{e:?}")))?);
  }

  let effective =
    crate::services::runtime_authority::resolve_provider_effective_authority(provider_base_url, &capability_ids)?;
  let limits = ResourceLimits::default();
  let mut network = Vec::new();
  let mut domain_net = Vec::new();
  for entry in &effective.network {
    let capability_id =
      CapabilityId::parse(&entry.capability_id).map_err(|e| StorageError::Validation(format!("{e:?}")))?;
    let endpoint_id = EndpointId::parse(&entry.endpoint_id).map_err(StorageError::Validation)?;
    let origin = HttpsOrigin::parse(&entry.origin).map_err(StorageError::Validation)?;
    let auth = AuthPolicyId::parse(&entry.auth_policy).map_err(StorageError::Validation)?;
    let method = match entry.method.as_str() {
      "GET" | "Get" | "get" => HttpMethod::Get,
      "POST" | "Post" | "post" => HttpMethod::Post,
      other => {
        return Err(StorageError::Validation(format!(
          "unsupported provider grant method {other}"
        )));
      }
    };
    domain_net.push(NetworkGrantEntry::with_mode_origin_and_response_modes_and_base_url(
      capability_id.clone(),
      endpoint_id.clone(),
      origin.clone(),
      NetworkOriginKind::InstanceConfigured,
      entry.base_url.clone(),
      method,
      auth.clone(),
      NetworkResourceMode::Bounded,
      limits,
      NetworkResponseBodyModes::ALL,
    ));
    network.push(NetworkGrantEntryRecord {
      id: new_id(),
      grant_set_id: grant_id,
      capability_id: capability_id.as_str().to_string(),
      endpoint_id: endpoint_id.as_str().to_string(),
      origin: origin.as_str().to_string(),
      base_url: entry.base_url.clone(),
      origin_kind: NetworkOriginKind::InstanceConfigured.as_str().into(),
      method: http_method_as_str(method).into(),
      auth_policy: auth.as_str().to_string(),
      resource_mode: NetworkResourceMode::Bounded.as_str().into(),
      max_request_bytes: limits.max_request_bytes(),
      max_response_bytes: limits.max_response_bytes(),
      max_stream_bytes: limits.max_stream_bytes(),
      timeout_ms: limits.timeout_ms(),
      response_body_modes: NetworkResponseBodyModes::ALL.as_canonical(),
    });
    let _ = PROVIDER_RUNTIME_ENDPOINT_ID;
    let _ = HOST_PROVIDER_INSTANCE_AUTH_POLICY_ID;
  }

  let identity = RuntimeIdentity::Package(PackageIdentity {
    package_digest: PackageDigest::parse(&content.content_digest)
      .map_err(|e| StorageError::Validation(format!("provider runtime package digest: {e}")))?,
  });
  let grant = ExecutionGrantSet::initial(
    provider_id,
    identity,
    PluginId::parse(&content.plugin_id).map_err(StorageError::Validation)?,
    SemVerVersion::parse(&content.version).map_err(StorageError::Validation)?,
    domain_caps,
    domain_net,
    vec![],
  )
  .map_err(|e| StorageError::Validation(e.to_string()))?;
  let permission_request_digest = compute_permission_request_digest(&content.manifest);
  Ok(ExecutionGrantSetBundle {
    header: ExecutionGrantSetRecord {
      id: grant_id,
      revision,
      subject_kind: GrantSubjectKind::ProviderInstance,
      subject_id: provider_id,
      plugin_id: content.plugin_id.clone(),
      plugin_version: content.version.clone(),
      package_digest: content.content_digest.clone(),
      permission_request_digest,
      authority_digest: grant.authority_digest().as_str().to_string(),
      approved_at: now_rfc3339(),
    },
    capabilities,
    network,
    pages: vec![],
  })
}

/// Pending binding for the resolved catalog default: exact digest, no legacy fallback.
///
/// The catalog default is the only default authority, so the binding starts in
/// `pending_activation` and is activated by [`ProviderRuntimeService::activate_with_catalog_default`].
pub(crate) fn apply_package_first_pending_binding(
  conn: &rusqlite::Connection,
  provider: &ProviderInstance,
  prepared: &PreparedProviderDefault,
  now: &str,
) -> Result<ProviderRuntimeBinding, StorageError> {
  use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState};

  let requirement = crate::domain::runtime_provider::ProviderRuntimeRequirementExport {
    adapter_id: Some(provider.adapter_id.clone()),
    runtime_kind: "wasm-component".into(),
    package_digest: Some(prepared.content.content_digest.clone()),
    plugin_id: Some(prepared.content.plugin_id.clone()),
    plugin_version: Some(prepared.content.version.clone()),
    plugin_api_version: None,
    legacy_aliases: vec![provider.adapter_id.clone()],
    capabilities: REQUIRED_LLM_CAPABILITIES.iter().cloned().map(str::to_string).collect(),
  };
  let requirement_json = serde_json::to_string(&requirement)
    .map_err(|e| StorageError::Internal(format!("serialize provider runtime requirement: {e}")))?;

  let binding = ProviderRuntimeBinding {
    provider_id: provider.id,
    adapter_id: provider.adapter_id.clone(),
    runtime_kind: ProviderRuntimeKind::WasmComponent,
    package_digest: Some(prepared.content.content_digest.clone()),
    grant_set_revision: None,
    state: ProviderRuntimeState::PendingActivation,
    error_code: None,
    error_message: None,
    runtime_requirement_json: Some(requirement_json),
    created_at: now.to_string(),
    updated_at: now.to_string(),
  };
  provider_runtime_bindings::insert(conn, &binding)?;
  Ok(binding)
}

/// Render an `Instant` as a stable RFC 3339 timestamp for preview expiry display.
fn format_rfc3339(instant: Instant) -> String {
  let system = std::time::SystemTime::now()
    .checked_add(instant.saturating_duration_since(Instant::now()))
    .unwrap_or(std::time::SystemTime::now());
  let duration = system.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
  let secs = duration.as_secs();
  let datetime = time::OffsetDateTime::from_unix_timestamp(secs as i64).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
  datetime
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
