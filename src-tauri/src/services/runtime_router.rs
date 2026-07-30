// ABOUTME: Resolve one immutable runtime adapter from authoritative instance pin state.
// ABOUTME: Loads Wasm artifacts only from immutable, trusted archive snapshots before binding a PluginPrincipal.
use crate::domain::plugin_package::{PublisherSource, runtime_kind_storage};
use crate::domain::runtime_lifecycle::{
  ExecutionGrantSetBundle, GrantSubjectKind, InstanceRuntimeState, parse_runtime_kind,
};
use crate::domain::runtime_plugin::{
  AuthPolicyId, AuthorityDigest, CapabilityId, ComponentArtifactDigest, EndpointId, ExecutionGrantSet, FileRole,
  GrantSetRevision, HttpMethod, HttpsOrigin, NetworkGrantEntry, PackageDigest, PackageIdentity, PageGrantEntry,
  PluginId, PluginManifestV1, PluginPrincipal, ResourceLimits, RuntimeIdentity, RuntimeKind, SemVerVersion,
};
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::error::StorageError;
use crate::repositories::{
  installed_plugin_versions, integration_instances, plugin_permission_grants, plugin_publishers,
};
use crate::services::plugin_store::PluginPackageService;
use crate::services::service_capabilities::{
  CapabilityHandler, DetectLanguageCapability, ServiceCapabilityRegistry, TranslateTextCapability,
};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

/// Resolved executor selection for one capability call. Never falls back after selection.
#[derive(Clone)]
pub enum RuntimeAdapter {
  BundledRust {
    handler: CapabilityHandler,
  },
  WasmComponent {
    package_digest: PackageDigest,
    artifact_digest: ComponentArtifactDigest,
    artifact_bytes: Arc<Vec<u8>>,
    grant: ExecutionGrantSet,
    principal_factory: WasmPrincipalFactory,
  },
}

/// Factory that issues a request-scoped principal for a verified grant set.
#[derive(Clone)]
pub struct WasmPrincipalFactory {
  grant: ExecutionGrantSet,
}

impl WasmPrincipalFactory {
  pub fn principal_for_request(
    &self,
    capability_id: &str,
    request_id: &str,
  ) -> Result<PluginPrincipal, CapabilityError> {
    self
      .grant
      .principal_for_request(capability_id, request_id)
      .map_err(|e| CapabilityError::new(CapabilityErrorCode::PermissionDenied, e.to_string()))
  }

  pub fn grant(&self) -> &ExecutionGrantSet {
    &self.grant
  }
}

/// Immutable SQLite-backed pin/grant/package authority for one capability invocation.
/// Loaded once via `Database::read_snapshot`; RuntimeRouter must not re-query these rows.
#[derive(Debug, Clone)]
pub struct SnapshotRuntimeResolution {
  pub instance_id: Uuid,
  pub plugin_id: String,
  pub runtime_kind: String,
  pub runtime_state: String,
  pub instance_updated_at: String,
  pub instance_config_json: String,
  pub package_digest: Option<String>,
  pub execution_grant_set_revision: Option<u64>,
  pub package_manifest_json: Option<String>,
  pub package_content_available: bool,
  pub package_permission_request_digest: Option<String>,
  pub package_plugin_id: Option<String>,
  pub package_plugin_version: Option<String>,
  pub publisher_key_id: Option<String>,
  pub publisher_fingerprint: Option<String>,
  pub publisher_public_key_hex: Option<String>,
  pub publisher_source: Option<PublisherSource>,
  pub publisher_enabled: bool,
  pub publisher_revoked: bool,
  pub grant_bundle: Option<ExecutionGrantSetBundle>,
}

/// Routes capability dispatch from the authoritative SQLite instance pin.
#[derive(Clone)]
pub struct RuntimeRouter {
  db: Database,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  bundled_handlers: Arc<ServiceCapabilityRegistry>,
  plugin_packages: PluginPackageService,
  #[allow(dead_code)]
  wasm_runtime: Arc<WasmRuntime>,
}

impl RuntimeRouter {
  pub fn new(
    db: Database,
    definition_registry: Arc<ServiceIntegrationRegistry>,
    bundled_handlers: Arc<ServiceCapabilityRegistry>,
    plugin_packages: PluginPackageService,
    wasm_runtime: Arc<WasmRuntime>,
  ) -> Self {
    Self {
      db,
      definition_registry,
      bundled_handlers,
      plugin_packages,
      wasm_runtime,
    }
  }

  /// Resolve one explicit executor for an instance capability. Reloads authoritative state.
  pub fn resolve(&self, instance_id: Uuid, capability_id: &str) -> Result<RuntimeAdapter, CapabilityError> {
    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, instance_id))
      .map_err(|e| map_storage_capability(e, "failed to load integration instance"))?;

    if !instance.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "integration instance is disabled",
      ));
    }

    if instance.runtime_state != InstanceRuntimeState::Active.as_str() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        format!("runtime is not active ({})", instance.runtime_state),
      ));
    }

    let runtime_kind =
      parse_runtime_kind(&instance.runtime_kind).map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?;

    match runtime_kind {
      RuntimeKind::BundledRust => self.resolve_bundled(&instance.plugin_id, capability_id),
      RuntimeKind::WasmComponent => self.resolve_wasm(&instance, capability_id),
      RuntimeKind::LegacyFrontendProvider => Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "legacy frontend provider runtime is not routed here",
      )),
      RuntimeKind::TrustedNativeWorker => Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "trusted native worker runtime is reserved for a later phase",
      )),
    }
  }

  fn resolve_bundled(&self, plugin_id: &str, capability_id: &str) -> Result<RuntimeAdapter, CapabilityError> {
    if !self.definition_registry.contains(plugin_id) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "plugin definition is missing",
      ));
    }
    let handler = self
      .bundled_handlers
      .get(plugin_id, capability_id)
      .cloned()
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability is not declared on this plugin",
        )
        .with_capability_id(capability_id)
      })?;
    Ok(RuntimeAdapter::BundledRust { handler })
  }

  fn resolve_wasm(
    &self,
    instance: &crate::domain::service_integration::IntegrationInstance,
    capability_id: &str,
  ) -> Result<RuntimeAdapter, CapabilityError> {
    let package_digest = instance.package_digest.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "wasm runtime pin is missing package digest",
      )
    })?;
    let grant_revision = instance.execution_grant_set_revision.ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "wasm runtime pin is missing grant-set revision",
      )
    })?;

    let version = self
      .db
      .read(|conn| installed_plugin_versions::get_optional(conn, package_digest))
      .map_err(|e| map_storage_capability(e, "failed to load installed package"))?
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, "installed package is missing"))?;

    if !version.content_available {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "installed package content is unavailable",
      ));
    }
    if version.plugin_id != instance.plugin_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "package plugin id does not match instance",
      ));
    }
    if version.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "package runtime kind is not wasm-component",
      ));
    }

    let publisher = self
      .db
      .read(|conn| crate::repositories::plugin_publishers::get(conn, &version.publisher_key_id))
      .map_err(|e| map_storage_capability(e, "failed to load publisher"))?;
    if publisher.revoked || !publisher.enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "publisher trust is revoked or disabled",
      ));
    }

    let bundle = self
      .db
      .read(|conn| {
        plugin_permission_grants::get_bundle_for_subject_package_revision(
          conn,
          GrantSubjectKind::IntegrationInstance,
          instance.id,
          package_digest,
          grant_revision,
        )
      })
      .map_err(|e| map_storage_capability(e, "execution grant set is missing"))?;

    if bundle.header.subject_id != instance.id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set is bound to a different instance",
      ));
    }
    if bundle.header.package_digest != package_digest {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set package digest mismatch",
      ));
    }
    if !bundle.capabilities.iter().any(|c| c.capability_id == capability_id) {
      return Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability is not granted for this instance",
        )
        .with_capability_id(capability_id),
      );
    }

    let manifest: PluginManifestV1 = serde_json::from_str(&version.manifest_json).map_err(|e| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid installed manifest: {e}"),
      )
    })?;
    validate_instance_configured_origins(&instance.config_json, &manifest, &bundle)?;
    let (artifact_digest, artifact_bytes) = self.load_verified_wasm_artifact(
      package_digest,
      &manifest,
      capability_id,
      &publisher.key_id,
      &publisher.fingerprint,
      &publisher.public_key_hex,
      publisher.source,
    )?;

    let grant = bundle_to_execution_grant_set(&bundle).map_err(|e| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid execution grant set: {e}"),
      )
    })?;

    Ok(RuntimeAdapter::WasmComponent {
      package_digest: PackageDigest::parse(package_digest)
        .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?,
      artifact_digest,
      artifact_bytes,
      principal_factory: WasmPrincipalFactory { grant: grant.clone() },
      grant,
    })
  }

  /// Resolve using an immutable invocation snapshot (no SQLite reload of pin/grant/package rows).
  /// Package bytes are loaded from a verified in-memory archive snapshot; call
  /// [`Self::recheck_pin_matches`] after the external verification.
  pub fn resolve_from_snapshot(
    &self,
    pin: &SnapshotRuntimeResolution,
    capability_id: &str,
  ) -> Result<RuntimeAdapter, CapabilityError> {
    if pin.runtime_state != InstanceRuntimeState::Active.as_str() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        format!("runtime is not active ({})", pin.runtime_state),
      ));
    }
    let runtime_kind =
      parse_runtime_kind(&pin.runtime_kind).map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?;
    match runtime_kind {
      RuntimeKind::BundledRust => self.resolve_bundled(&pin.plugin_id, capability_id),
      RuntimeKind::WasmComponent => self.resolve_wasm_from_snapshot(pin, capability_id),
      RuntimeKind::LegacyFrontendProvider => Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "legacy frontend provider runtime is not routed here",
      )),
      RuntimeKind::TrustedNativeWorker => Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "trusted native worker runtime is reserved for a later phase",
      )),
    }
  }

  /// Post-FS recheck: full package-backed authority must still match the immutable snapshot.
  /// Prefer [`crate::services::service_capabilities::ServiceCapabilityService::recheck_invocation_snapshot`]
  /// for profile command paths (includes profile binding/preferences).
  pub fn recheck_pin_matches(&self, pin: &SnapshotRuntimeResolution) -> Result<(), CapabilityError> {
    let live = self
      .db
      .read_snapshot(|conn| {
        let instance = integration_instances::get(conn, pin.instance_id)?;
        let mut package_content_available = false;
        let mut package_permission_request_digest = None;
        let mut package_manifest_json = None;
        let mut package_plugin_id = None;
        let mut package_plugin_version = None;
        let mut publisher_key_id = None;
        let mut publisher_fingerprint = None;
        let mut publisher_public_key_hex = None;
        let mut publisher_source = None;
        let mut publisher_enabled = false;
        let mut publisher_revoked = true;
        let mut grant_bundle = None;
        if let (Some(digest), Some(rev)) = (
          instance.package_digest.as_deref(),
          instance.execution_grant_set_revision,
        ) {
          let version = installed_plugin_versions::get(conn, digest)?;
          let publisher = plugin_publishers::get(conn, &version.publisher_key_id)?;
          package_content_available = version.content_available;
          package_permission_request_digest = Some(version.permission_request_digest.clone());
          package_manifest_json = Some(version.manifest_json.clone());
          package_plugin_id = Some(version.plugin_id.clone());
          package_plugin_version = Some(version.version.clone());
          publisher_key_id = Some(publisher.key_id.clone());
          publisher_fingerprint = Some(publisher.fingerprint.clone());
          publisher_public_key_hex = Some(publisher.public_key_hex.clone());
          publisher_source = Some(publisher.source);
          publisher_enabled = publisher.enabled;
          publisher_revoked = publisher.revoked;
          grant_bundle = Some(plugin_permission_grants::get_bundle_for_subject_package_revision(
            conn,
            GrantSubjectKind::IntegrationInstance,
            instance.id,
            digest,
            rev,
          )?);
        }
        let instance_config_json = instance.config_json.clone();
        Ok((
          instance,
          SnapshotRuntimeResolution {
            instance_id: pin.instance_id,
            plugin_id: pin.plugin_id.clone(),
            runtime_kind: String::new(),
            runtime_state: String::new(),
            instance_updated_at: String::new(),
            instance_config_json,
            package_digest: None,
            execution_grant_set_revision: None,
            package_manifest_json,
            package_content_available,
            package_permission_request_digest,
            package_plugin_id,
            package_plugin_version,
            publisher_key_id,
            publisher_fingerprint,
            publisher_public_key_hex,
            publisher_source,
            publisher_enabled,
            publisher_revoked,
            grant_bundle,
          },
        ))
      })
      .map_err(|e| map_storage_capability(e, "failed to recheck invocation authority"))?;
    let (instance, live_pkg) = live;
    if instance.updated_at != pin.instance_updated_at
      || instance.package_digest != pin.package_digest
      || instance.execution_grant_set_revision != pin.execution_grant_set_revision
      || instance.runtime_kind != pin.runtime_kind
      || instance.runtime_state != pin.runtime_state
      || instance.plugin_id != pin.plugin_id
      || instance.config_json != pin.instance_config_json
      || !instance.enabled
    {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "runtime pin changed concurrently during invocation",
      ));
    }
    if pin.package_digest.is_some() {
      if live_pkg.package_content_available != pin.package_content_available
        || live_pkg.package_permission_request_digest != pin.package_permission_request_digest
        || live_pkg.package_manifest_json != pin.package_manifest_json
        || live_pkg.package_plugin_id != pin.package_plugin_id
        || live_pkg.package_plugin_version != pin.package_plugin_version
        || live_pkg.publisher_key_id != pin.publisher_key_id
        || live_pkg.publisher_fingerprint != pin.publisher_fingerprint
        || live_pkg.publisher_public_key_hex != pin.publisher_public_key_hex
        || live_pkg.publisher_source != pin.publisher_source
        || live_pkg.publisher_enabled != pin.publisher_enabled
        || live_pkg.publisher_revoked != pin.publisher_revoked
        || !canonical_grant_bundles_equal(live_pkg.grant_bundle.as_ref(), pin.grant_bundle.as_ref())
      {
        return Err(CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          "package, publisher, or grant authority changed concurrently during invocation",
        ));
      }
    }
    Ok(())
  }

  fn resolve_wasm_from_snapshot(
    &self,
    pin: &SnapshotRuntimeResolution,
    capability_id: &str,
  ) -> Result<RuntimeAdapter, CapabilityError> {
    let package_digest = pin.package_digest.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "wasm runtime pin is missing package digest",
      )
    })?;
    let grant_revision = pin.execution_grant_set_revision.ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "wasm runtime pin is missing grant-set revision",
      )
    })?;
    if !pin.package_content_available {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "installed package content is unavailable",
      ));
    }
    if pin.publisher_revoked || !pin.publisher_enabled {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "publisher trust is revoked or disabled",
      ));
    }
    let bundle = pin.grant_bundle.as_ref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "execution grant set is missing from invocation snapshot",
      )
    })?;
    if bundle.header.subject_id != pin.instance_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set is bound to a different instance",
      ));
    }
    if bundle.header.package_digest != package_digest || bundle.header.revision != grant_revision {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant set package digest or revision mismatch",
      ));
    }
    if !bundle.capabilities.iter().any(|c| c.capability_id == capability_id) {
      return Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability is not granted for this instance",
        )
        .with_capability_id(capability_id),
      );
    }
    let manifest_json = pin.package_manifest_json.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "package manifest missing from invocation snapshot",
      )
    })?;
    let manifest: PluginManifestV1 = serde_json::from_str(manifest_json).map_err(|e| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid installed manifest: {e}"),
      )
    })?;
    if manifest.id != pin.plugin_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "package plugin id does not match instance",
      ));
    }
    // Canonical grant bind: recompute permission_request_digest from signed manifest and
    // verify grant header + children against instance/package/manifest identity.
    verify_grant_canonical_bind(pin, bundle, &manifest, package_digest, grant_revision, capability_id)?;
    validate_instance_configured_origins(&pin.instance_config_json, &manifest, bundle)?;
    let publisher_key_id = pin.publisher_key_id.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "publisher key id is missing from invocation snapshot",
      )
    })?;
    let publisher_fingerprint = pin.publisher_fingerprint.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "publisher fingerprint is missing from invocation snapshot",
      )
    })?;
    let publisher_public_key_hex = pin.publisher_public_key_hex.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "publisher public key is missing from invocation snapshot",
      )
    })?;
    let publisher_source = pin.publisher_source.ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "publisher source is missing from invocation snapshot",
      )
    })?;
    let (artifact_digest, artifact_bytes) = self.load_verified_wasm_artifact(
      package_digest,
      &manifest,
      capability_id,
      publisher_key_id,
      publisher_fingerprint,
      publisher_public_key_hex,
      publisher_source,
    )?;
    let grant = bundle_to_execution_grant_set(bundle).map_err(|e| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        format!("invalid execution grant set: {e}"),
      )
    })?;
    Ok(RuntimeAdapter::WasmComponent {
      package_digest: PackageDigest::parse(package_digest)
        .map_err(|e| CapabilityError::new(CapabilityErrorCode::Internal, e))?,
      artifact_digest,
      artifact_bytes,
      principal_factory: WasmPrincipalFactory { grant: grant.clone() },
      grant,
    })
  }

  /// Load one executable artifact from an immutable archive snapshot verified at this call.
  ///
  /// The store tree is compared against the snapshot but never reopened for Wasm bytes, closing
  /// the verify-then-reopen window for external same-permission store replacements.
  fn load_verified_wasm_artifact(
    &self,
    package_digest: &str,
    expected_manifest: &PluginManifestV1,
    capability_id: &str,
    publisher_key_id: &str,
    publisher_fingerprint: &str,
    publisher_public_key_hex: &str,
    publisher_source: PublisherSource,
  ) -> Result<(ComponentArtifactDigest, Arc<Vec<u8>>), CapabilityError> {
    let verified = self
      .plugin_packages
      .verify_runtime_store_snapshot(
        package_digest,
        publisher_key_id,
        publisher_fingerprint,
        publisher_public_key_hex,
        publisher_source,
      )
      .map_err(|err| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          format!("runtime package snapshot verification failed: {err}"),
        )
      })?;
    if verified.manifest != *expected_manifest {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "signed package manifest differs from the installed package record",
      ));
    }
    let artifact_path = artifact_path_for_capability(&verified.manifest, capability_id)?;
    let file_entry = verified
      .manifest
      .files
      .iter()
      .find(|file| file.path == artifact_path && file.role == FileRole::RuntimeArtifact)
      .ok_or_else(|| {
        CapabilityError::new(
          CapabilityErrorCode::PluginUnavailable,
          "runtime artifact is missing from the signed file index",
        )
      })?;
    let artifact_bytes = verified.extracted_files.get(artifact_path).cloned().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "runtime artifact is missing from the verified archive snapshot",
      )
    })?;
    if artifact_bytes.len() as u64 != file_entry.bytes {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PluginUnavailable,
        "runtime artifact length differs from the verified file index",
      ));
    }
    let artifact_digest = ComponentArtifactDigest::parse(&file_entry.sha256)
      .map_err(|err| CapabilityError::new(CapabilityErrorCode::PluginUnavailable, err))?;
    Ok((artifact_digest, Arc::new(artifact_bytes)))
  }

  pub fn resolve_translate(
    &self,
    instance_id: Uuid,
    capability_id: &str,
  ) -> Result<ResolvedTranslate, CapabilityError> {
    match self.resolve(instance_id, capability_id)? {
      RuntimeAdapter::BundledRust {
        handler: CapabilityHandler::TranslateText(h),
      } => Ok(ResolvedTranslate::Bundled(h)),
      RuntimeAdapter::BundledRust { .. } => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
      RuntimeAdapter::WasmComponent {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory,
      } => Ok(ResolvedTranslate::Wasm {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory,
      }),
    }
  }

  pub fn resolve_detect(&self, instance_id: Uuid, capability_id: &str) -> Result<ResolvedDetect, CapabilityError> {
    match self.resolve(instance_id, capability_id)? {
      RuntimeAdapter::BundledRust {
        handler: CapabilityHandler::DetectLanguage(h),
      } => Ok(ResolvedDetect::Bundled(h)),
      RuntimeAdapter::BundledRust { .. } => Err(
        CapabilityError::new(
          CapabilityErrorCode::PermissionDenied,
          "capability handler type mismatch",
        )
        .with_capability_id(capability_id),
      ),
      RuntimeAdapter::WasmComponent {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory,
      } => Ok(ResolvedDetect::Wasm {
        package_digest,
        artifact_digest,
        artifact_bytes,
        grant,
        principal_factory,
      }),
    }
  }
}

/// Resolve the runtime artifact path for a capability: the capability's declared artifact
/// if present, otherwise the package default `runtime.artifact`. Supports packages shipping
/// one component per WIT world (e.g. translate.text + translate.detect) behind one plugin id.
fn validate_instance_configured_origins(
  config_json: &str,
  manifest: &PluginManifestV1,
  grant: &ExecutionGrantSetBundle,
) -> Result<(), CapabilityError> {
  let config: serde_json::Value = serde_json::from_str(config_json).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "integration config is not valid JSON",
    )
  })?;
  for endpoint in manifest
    .permissions
    .network
    .iter()
    .filter(|endpoint| endpoint.instance_origin_config_field.is_some())
  {
    let field = endpoint.instance_origin_config_field.as_deref().unwrap_or_default();
    let raw = config
      .get(field)
      .and_then(serde_json::Value::as_str)
      .unwrap_or("")
      .trim();
    let granted_origins: HashSet<&str> = grant
      .network
      .iter()
      .filter(|entry| entry.endpoint_id == endpoint.id)
      .map(|entry| entry.origin.as_str())
      .collect();
    if granted_origins.is_empty() {
      continue;
    }
    if raw.is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        format!(
          "configured network origin for {} requires permission approval",
          endpoint.id
        ),
      ));
    }
    let normalized = crate::services::google_translate_web::normalize_proxy_url(raw)
      .map_err(|message| CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, message))?;
    if granted_origins.len() != 1 || !granted_origins.contains(normalized.origin.as_str()) {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        format!(
          "configured network origin for {} requires permission approval",
          endpoint.id
        ),
      ));
    }
  }
  Ok(())
}

fn artifact_path_for_capability<'a>(
  manifest: &'a PluginManifestV1,
  capability_id: &str,
) -> Result<&'a str, CapabilityError> {
  if let Some(cap) = manifest.capabilities.iter().find(|c| c.id == capability_id) {
    if let Some(artifact) = &cap.artifact {
      return Ok(artifact.as_str());
    }
  }
  manifest.runtime.artifact.as_deref().ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "wasm package is missing runtime artifact path",
    )
  })
}

pub enum ResolvedTranslate {
  Bundled(Arc<dyn TranslateTextCapability>),
  Wasm {
    package_digest: PackageDigest,
    artifact_digest: ComponentArtifactDigest,
    artifact_bytes: Arc<Vec<u8>>,
    grant: ExecutionGrantSet,
    principal_factory: WasmPrincipalFactory,
  },
}

pub enum ResolvedDetect {
  Bundled(Arc<dyn DetectLanguageCapability>),
  Wasm {
    package_digest: PackageDigest,
    artifact_digest: ComponentArtifactDigest,
    artifact_bytes: Arc<Vec<u8>>,
    grant: ExecutionGrantSet,
    principal_factory: WasmPrincipalFactory,
  },
}

fn canonical_grant_bundles_equal(a: Option<&ExecutionGrantSetBundle>, b: Option<&ExecutionGrantSetBundle>) -> bool {
  match (a, b) {
    (None, None) => true,
    (Some(a), Some(b)) => {
      if a.header.subject_kind != b.header.subject_kind
        || a.header.subject_id != b.header.subject_id
        || a.header.plugin_id != b.header.plugin_id
        || a.header.plugin_version != b.header.plugin_version
        || a.header.package_digest != b.header.package_digest
        || a.header.permission_request_digest != b.header.permission_request_digest
        || a.header.authority_digest != b.header.authority_digest
        || a.header.revision != b.header.revision
      {
        return false;
      }
      let mut a_caps: Vec<_> = a.capabilities.iter().map(|c| c.capability_id.as_str()).collect();
      let mut b_caps: Vec<_> = b.capabilities.iter().map(|c| c.capability_id.as_str()).collect();
      a_caps.sort_unstable();
      b_caps.sort_unstable();
      if a_caps != b_caps {
        return false;
      }
      let mut a_net: Vec<_> = a
        .network
        .iter()
        .map(|n| {
          (
            n.capability_id.as_str(),
            n.endpoint_id.as_str(),
            n.origin.as_str(),
            n.method.as_str(),
            n.auth_policy.as_str(),
            n.resource_mode.as_str(),
            n.max_request_bytes,
            n.max_response_bytes,
            n.max_stream_bytes,
            n.timeout_ms,
          )
        })
        .collect();
      let mut b_net: Vec<_> = b
        .network
        .iter()
        .map(|n| {
          (
            n.capability_id.as_str(),
            n.endpoint_id.as_str(),
            n.origin.as_str(),
            n.method.as_str(),
            n.auth_policy.as_str(),
            n.resource_mode.as_str(),
            n.max_request_bytes,
            n.max_response_bytes,
            n.max_stream_bytes,
            n.timeout_ms,
          )
        })
        .collect();
      a_net.sort_unstable();
      b_net.sort_unstable();
      if a_net != b_net {
        return false;
      }
      let mut a_pages: Vec<_> = a
        .pages
        .iter()
        .map(|p| {
          (
            p.page_id.clone(),
            p.allowed_actions.clone(),
            p.delegated_capability_majors.clone(),
            p.delegated_endpoint_aliases.clone(),
          )
        })
        .collect();
      let mut b_pages: Vec<_> = b
        .pages
        .iter()
        .map(|p| {
          (
            p.page_id.clone(),
            p.allowed_actions.clone(),
            p.delegated_capability_majors.clone(),
            p.delegated_endpoint_aliases.clone(),
          )
        })
        .collect();
      a_pages.sort_by(|x, y| x.0.cmp(&y.0));
      b_pages.sort_by(|x, y| x.0.cmp(&y.0));
      a_pages == b_pages
    }
    _ => false,
  }
}

fn map_storage_capability(err: StorageError, fallback: &str) -> CapabilityError {
  match err {
    StorageError::NotFound(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
    StorageError::PluginUnavailable(msg) => CapabilityError::new(CapabilityErrorCode::PluginUnavailable, msg),
    StorageError::Validation(msg) => CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg),
    StorageError::Conflict(msg) => CapabilityError::new(CapabilityErrorCode::Internal, msg),
    _ => CapabilityError::new(CapabilityErrorCode::Internal, fallback),
  }
}

/// Fail closed when the snapshot grant is not a canonical bind of the signed package + pin.
fn verify_grant_canonical_bind(
  pin: &SnapshotRuntimeResolution,
  bundle: &ExecutionGrantSetBundle,
  manifest: &PluginManifestV1,
  package_digest: &str,
  grant_revision: u64,
  capability_id: &str,
) -> Result<(), CapabilityError> {
  use crate::domain::plugin_package::compute_permission_request_digest;
  use crate::domain::runtime_lifecycle::GrantSubjectKind;

  if bundle.header.subject_kind != GrantSubjectKind::IntegrationInstance {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant subject_kind is not integration_instance",
    ));
  }
  if bundle.header.subject_id != pin.instance_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant subject_id does not match instance",
    ));
  }
  if bundle.header.plugin_id != pin.plugin_id {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant plugin_id does not match instance",
    ));
  }
  if let Some(pkg_plugin_id) = pin.package_plugin_id.as_deref() {
    if bundle.header.plugin_id != pkg_plugin_id {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant plugin_id does not match installed package",
      ));
    }
  }
  if let Some(pkg_version) = pin.package_plugin_version.as_deref() {
    if bundle.header.plugin_version != pkg_version {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant plugin_version does not match installed package",
      ));
    }
  }
  if bundle.header.package_digest != package_digest {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant package_digest mismatch",
    ));
  }
  if bundle.header.revision != grant_revision {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant revision mismatch",
    ));
  }
  let expected_permission = compute_permission_request_digest(manifest);
  if bundle.header.permission_request_digest != expected_permission {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant permission_request_digest does not match signed manifest",
    ));
  }
  if let Some(pkg_permission) = pin.package_permission_request_digest.as_deref() {
    if bundle.header.permission_request_digest != pkg_permission {
      return Err(CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "grant permission_request_digest does not match installed package record",
      ));
    }
  }
  // Reconstruct domain grant and verify authority digest + child consistency.
  let grant = bundle_to_execution_grant_set(bundle).map_err(|e| {
    CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      format!("grant children failed canonical restore: {e}"),
    )
  })?;
  if grant.authority_digest().as_str() != bundle.header.authority_digest {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant authority_digest does not match children",
    ));
  }
  if !grant.capabilities().any(|c| c.as_str() == capability_id) {
    return Err(
      CapabilityError::new(
        CapabilityErrorCode::PermissionDenied,
        "capability is not present in restored grant children",
      )
      .with_capability_id(capability_id),
    );
  }
  // Child grant_set_id must all bind to the header id.
  if bundle.capabilities.iter().any(|c| c.grant_set_id != bundle.header.id)
    || bundle.network.iter().any(|n| n.grant_set_id != bundle.header.id)
    || bundle.pages.iter().any(|p| p.grant_set_id != bundle.header.id)
  {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PermissionDenied,
      "grant children grant_set_id does not match header",
    ));
  }
  Ok(())
}

/// Rebuild the in-memory ExecutionGrantSet from a persisted bundle.
pub fn bundle_to_execution_grant_set(bundle: &ExecutionGrantSetBundle) -> Result<ExecutionGrantSet, String> {
  let package_digest = PackageDigest::parse(&bundle.header.package_digest)?;
  let identity = RuntimeIdentity::Package(PackageIdentity { package_digest });
  let plugin_id = PluginId::parse(&bundle.header.plugin_id)?;
  let plugin_version = SemVerVersion::parse(&bundle.header.plugin_version)?;
  let revision = GrantSetRevision::new(bundle.header.revision)?;

  let mut capabilities = Vec::with_capacity(bundle.capabilities.len());
  for cap in &bundle.capabilities {
    capabilities.push(CapabilityId::parse(&cap.capability_id).map_err(|e| format!("{e:?}"))?);
  }

  let mut network = Vec::with_capacity(bundle.network.len());
  for entry in &bundle.network {
    let method = parse_http_method(&entry.method)?;
    let limits = ResourceLimits::new(
      entry.max_request_bytes,
      entry.max_response_bytes,
      entry.max_stream_bytes,
      entry.timeout_ms,
    )
    .map_err(|e| e.to_string())?;
    let mode = crate::domain::runtime_plugin::NetworkResourceMode::parse(&entry.resource_mode)?;
    network.push(NetworkGrantEntry::with_mode(
      CapabilityId::parse(&entry.capability_id).map_err(|e| format!("{e:?}"))?,
      EndpointId::parse(&entry.endpoint_id)?,
      HttpsOrigin::parse(&entry.origin)?,
      method,
      AuthPolicyId::parse(&entry.auth_policy)?,
      mode,
      limits,
    ));
  }

  let mut pages = Vec::with_capacity(bundle.pages.len());
  for page in &bundle.pages {
    let action_refs: Vec<&str> = page.allowed_actions.iter().map(String::as_str).collect();
    let major_refs: Vec<&str> = page.delegated_capability_majors.iter().map(String::as_str).collect();
    let alias_refs: Vec<&str> = page.delegated_endpoint_aliases.iter().map(String::as_str).collect();
    pages.push(PageGrantEntry::parse_with_delegation(
      &page.page_id,
      &action_refs,
      &major_refs,
      &alias_refs,
    )?);
  }

  let digest = AuthorityDigest::parse(&bundle.header.authority_digest)?;
  ExecutionGrantSet::restore_validated(
    bundle.header.subject_id,
    identity,
    plugin_id,
    plugin_version,
    revision,
    capabilities,
    network,
    pages,
    digest,
  )
  .map_err(|e| e.to_string())
}

pub fn parse_http_method(value: &str) -> Result<HttpMethod, String> {
  match value {
    "GET" => Ok(HttpMethod::Get),
    "POST" => Ok(HttpMethod::Post),
    "PUT" => Ok(HttpMethod::Put),
    "PATCH" => Ok(HttpMethod::Patch),
    "DELETE" => Ok(HttpMethod::Delete),
    "HEAD" => Ok(HttpMethod::Head),
    "OPTIONS" => Ok(HttpMethod::Options),
    other => Err(format!("invalid http method: {other}")),
  }
}

pub fn http_method_as_str(method: HttpMethod) -> &'static str {
  match method {
    HttpMethod::Get => "GET",
    HttpMethod::Post => "POST",
    HttpMethod::Put => "PUT",
    HttpMethod::Patch => "PATCH",
    HttpMethod::Delete => "DELETE",
    HttpMethod::Head => "HEAD",
    HttpMethod::Options => "OPTIONS",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::runtime_lifecycle::{
    CapabilityGrantEntryRecord, ExecutionGrantSetRecord, NetworkGrantEntryRecord,
  };
  use crate::domain::runtime_plugin::{
    RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
    RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES, RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::plugin_permission_grants;
  use crate::storage::Database;

  fn sample_bundle(subject_id: Uuid, package_digest: &str) -> ExecutionGrantSetBundle {
    let grant_id = new_id();
    let now = now_rfc3339();
    let caps = vec![CapabilityGrantEntryRecord {
      id: new_id(),
      grant_set_id: grant_id,
      capability_id: "translate.text@1".into(),
    }];
    let network = vec![NetworkGrantEntryRecord {
      id: new_id(),
      grant_set_id: grant_id,
      capability_id: "translate.text@1".into(),
      endpoint_id: "approved".into(),
      origin: "https://conformance.example".into(),
      method: "GET".into(),
      auth_policy: "host.none.v1".into(),
      resource_mode: "bounded".into(),
      max_request_bytes: RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
      max_response_bytes: RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
      max_stream_bytes: RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      timeout_ms: RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
    }];
    // Build authority digest from domain types.
    let domain_caps = vec![CapabilityId::parse("translate.text@1").unwrap()];
    let domain_net = vec![NetworkGrantEntry::new(
      CapabilityId::parse("translate.text@1").unwrap(),
      EndpointId::parse("approved").unwrap(),
      HttpsOrigin::parse("https://conformance.example").unwrap(),
      HttpMethod::Get,
      AuthPolicyId::parse("host.none.v1").unwrap(),
      ResourceLimits::default(),
    )];
    let authority = crate::domain::runtime_plugin::compute_authority_digest(&domain_caps, &domain_net, &[]);
    ExecutionGrantSetBundle {
      header: ExecutionGrantSetRecord {
        id: grant_id,
        revision: 1,
        subject_kind: GrantSubjectKind::IntegrationInstance,
        subject_id,
        plugin_id: "langnext.conformance".into(),
        plugin_version: "0.1.0".into(),
        package_digest: package_digest.into(),
        permission_request_digest: "b".repeat(64),
        authority_digest: authority.as_str().to_string(),
        approved_at: now,
      },
      capabilities: caps,
      network,
      pages: vec![],
    }
  }

  #[test]
  fn runtime_router_bundle_round_trip_preserves_authority() {
    let subject = new_id();
    let digest = "a".repeat(64);
    let bundle = sample_bundle(subject, &digest);
    let grant = bundle_to_execution_grant_set(&bundle).unwrap();
    assert_eq!(grant.instance_id(), subject);
    assert_eq!(grant.revision().as_u64(), 1);
    assert_eq!(grant.authority_digest().as_str(), bundle.header.authority_digest);
  }

  #[test]
  fn runtime_router_cross_instance_grant_lookup_denied() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();

    // Need an installed package row for FK.
    let digest = "c".repeat(64);
    let now = now_rfc3339();
    db.transaction(|uow| {
      crate::repositories::plugin_publishers::upsert_vendor(
        uow.conn(),
        "langnext.conformance",
        &"d".repeat(64),
        &"ab".repeat(32),
      )?;
      crate::repositories::installed_plugin_versions::insert(
        uow.conn(),
        &crate::domain::plugin_package::InstalledPluginVersion {
          package_digest: digest.clone(),
          plugin_id: "langnext.conformance".into(),
          version: "0.1.0".into(),
          publisher_key_id: "langnext.conformance".into(),
          publisher_fingerprint: "d".repeat(64),
          runtime_kind: "wasm-component".into(),
          manifest_json: "{}".into(),
          permission_request_digest: "e".repeat(64),
          content_available: true,
          installed_at: now.clone(),
        },
      )?;
      let subject_a = new_id();
      let subject_b = new_id();
      let mut bundle = sample_bundle(subject_a, &digest);
      plugin_permission_grants::insert_bundle(uow.conn(), &bundle)?;
      // Lookup for subject B must fail.
      let err = plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        GrantSubjectKind::IntegrationInstance,
        subject_b,
        &digest,
        1,
      );
      assert!(matches!(err, Err(StorageError::NotFound(_))));
      // Mutate bundle header subject and re-insert as revision for B should be a different grant.
      bundle.header.id = new_id();
      bundle.header.subject_id = subject_b;
      for cap in &mut bundle.capabilities {
        cap.id = new_id();
        cap.grant_set_id = bundle.header.id;
      }
      for net in &mut bundle.network {
        net.id = new_id();
        net.grant_set_id = bundle.header.id;
      }
      plugin_permission_grants::insert_bundle(uow.conn(), &bundle)?;
      let loaded_a = plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        GrantSubjectKind::IntegrationInstance,
        subject_a,
        &digest,
        1,
      )?;
      let loaded_b = plugin_permission_grants::get_bundle_for_subject_package_revision(
        uow.conn(),
        GrantSubjectKind::IntegrationInstance,
        subject_b,
        &digest,
        1,
      )?;
      assert_ne!(loaded_a.header.id, loaded_b.header.id);
      assert_ne!(loaded_a.header.subject_id, loaded_b.header.subject_id);
      Ok(())
    })
    .unwrap();
  }
}
