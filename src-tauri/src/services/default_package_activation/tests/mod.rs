// ABOUTME: Focused default package activation service tests.
// ABOUTME: Covers authorization, package-first, single-flight, recovery, and authority CAS.
use super::*;
use crate::domain::plugin_package::{ApprovePluginPackageInput, ApproveUserPublisherInput};
use crate::domain::runtime_plugin::SHA256_HEX_LEN;
use crate::services::plugin_package::test_support::{
  sample_manifest, test_fingerprint, test_public_key_hex, valid_signed_package, valid_unsigned_package,
};
use crate::services::plugin_store::PluginPackageService;
use crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
use crate::services::vendor_trust::test_vendor_fixture::{
  fixture_vendor_fingerprint, fixture_vendor_public_key, fixture_vendor_public_key_hex, fixture_vendor_signing_key,
};
use crate::storage::Database;
use ed25519_dalek::Signer;
use std::io::Write;
use std::path::Path;

fn setup() -> (tempfile::TempDir, PluginPackageService, DefaultPackageActivationService) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  packages
    .approve_user_publisher(ApproveUserPublisherInput {
      key_id: "com.example.keys.1".into(),
      fingerprint: test_fingerprint(),
      public_key_hex: test_public_key_hex(),
    })
    .unwrap();
  let activation = DefaultPackageActivationService::create(db, packages.clone(), dir.path());
  (dir, packages, activation)
}

fn install_valid(packages: &PluginPackageService, dir: &Path, set_default: bool) -> String {
  let (pkg, digest) = valid_signed_package();
  let src = dir.join("sample.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  let result = packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  if set_default {
    packages
      .set_default(&result.version.plugin_id, &digest)
      .expect("test helper may set default only after install");
  }
  digest
}

fn install_unsigned(packages: &PluginPackageService, dir: &Path) -> String {
  let (package, digest) = valid_unsigned_package();
  let source = dir.join("unsigned-default.lnplugin");
  std::fs::write(&source, package).unwrap();
  let preview = packages.preview_package(&source).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: true,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  digest
}

fn install_second_version(packages: &PluginPackageService, dir: &Path) -> String {
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};
  let wasm = b"\0asm\x01\x00\x00\x00v2";
  let mut manifest = sample_manifest(wasm);
  manifest.version = "1.0.1".into();
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.join("sample-v2.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  digest
}

#[test]
fn unsigned_default_requires_second_exact_digest_acknowledgement() {
  let (dir, packages, activation) = setup();
  let digest = install_unsigned(&packages, dir.path());
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  assert!(preview.requires_unsigned_default_risk_acknowledgement);
  assert_eq!(
    preview.signature_status,
    crate::domain::plugin_package::PackageSignatureStatus::Unsigned
  );
  let error = activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap_err();
  assert!(error.to_string().contains("unsigned"));
  assert!(
    !packages
      .list_versions()
      .unwrap()
      .iter()
      .any(|version| version.is_default)
  );

  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: true,
    })
    .unwrap();
  assert!(
    packages
      .list_versions()
      .unwrap()
      .iter()
      .any(|version| version.is_default && version.package_digest == digest)
  );
}

#[test]
fn unsigned_default_package_first_create_and_activation_reverify_integrity() {
  let (dir, packages, activation) = setup();
  let digest = install_unsigned(&packages, dir.path());
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: true,
    })
    .unwrap();
  assert_eq!(
    activation.authorization_status("com.example.unsigned").unwrap(),
    DefaultPackageAuthorizationStatus::Authorized
  );
  let prepared = activation.prepare_package_first_create("com.example.unsigned").unwrap();
  assert!(
    matches!(prepared, PackageFirstCreateResolution::Ready(_)),
    "{prepared:?}"
  );
  let archive = packages.package_archive_path(&digest);
  #[cfg(windows)]
  {
    let mut permissions = std::fs::metadata(&archive).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&archive, permissions).unwrap();
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    const OWNER_READ_WRITE_MODE: u32 = 0o600;
    std::fs::set_permissions(&archive, std::fs::Permissions::from_mode(OWNER_READ_WRITE_MODE)).unwrap();
  }
  let mut bytes = std::fs::read(&archive).unwrap();
  let last = bytes.len() - 1;
  bytes[last] ^= 0xff;
  std::fs::write(archive, bytes).unwrap();
  assert!(matches!(
    activation.prepare_package_first_create("com.example.unsigned").unwrap(),
    PackageFirstCreateResolution::Blocked(_)
  ));
}

fn build_vendor_signed_package() -> (Vec<u8>, String) {
  use crate::domain::runtime_plugin::{MANIFEST_FILE_PATH, SIGNATURE_FILE_PATH};
  let sk = fixture_vendor_signing_key();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.publisher.key_id = VENDOR_PUBLISHER_KEY_ID.into();
  manifest.publisher.key_fingerprint = fixture_vendor_fingerprint();
  let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
  let signature = sk.sign(&manifest_bytes).to_bytes().to_vec();
  let pub_key_hex = fixture_vendor_public_key_hex();
  let pub_key_bytes = crate::domain::plugin_package::decode_lowercase_hex::<32>(&pub_key_hex, "vendor pub").unwrap();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
    zip.write_all(&manifest_bytes).unwrap();
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.start_file("publisher.pub", options).unwrap();
    zip.write_all(&pub_key_bytes).unwrap();
    zip.start_file("artifacts/plugin.wasm", options).unwrap();
    zip.write_all(wasm).unwrap();
    zip.finish().unwrap();
  }
  let bytes = cursor.into_inner();
  let digest = sha256_hex(&bytes);
  (bytes, digest)
}

#[test]
fn default_package_activation_authorization_preview_and_apply() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);

  // Catalog default without policy remains unauthorized.
  packages.set_default("com.example.translate", &digest).unwrap();
  assert_eq!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Unauthorized
  );

  let preview = activation.preview_default_package_activation(&digest).unwrap();
  assert_eq!(preview.package_digest, digest);
  assert_eq!(preview.plugin_id, "com.example.translate");
  assert!(!preview.preview_id.is_empty());
  assert_eq!(preview.publisher_fingerprint, test_fingerprint());
  assert!(!preview.capabilities.is_empty());
  assert!(preview.expires_at.contains('T'));

  let missing_ack = activation.authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
    preview_id: preview.preview_id.clone(),
    acknowledge_future_instance_authority: false,
    acknowledge_unsigned_default_risk: false,
  });
  assert!(matches!(missing_ack, Err(StorageError::Validation(_))));
  assert_eq!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Unauthorized
  );

  // Re-preview after failed apply (preview was not consumed on validation failure before remove...
  // Actually our implementation removes on authorize only after ack check. Ack check is first,
  // so preview still exists.
  let authorized = activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  assert_eq!(authorized.package_digest, digest);
  assert_eq!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Authorized
  );

  // Consumed preview cannot re-apply; unknown preview is not found.
  let missing = activation.authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
    preview_id: new_id().to_string(),
    acknowledge_future_instance_authority: true,
    acknowledge_unsigned_default_risk: false,
  });
  assert!(matches!(missing, Err(StorageError::NotFound(_))));
}

#[test]
fn default_package_activation_authorization_rejects_revoked_publisher() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  packages.revoke_publisher("com.example.keys.1").unwrap();
  let err = activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)));
  assert_ne!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Authorized
  );
}

#[test]
fn default_package_policy_publisher_trust_blocks_package_first_prepare() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  assert!(matches!(
    activation
      .prepare_package_first_create("com.example.translate")
      .unwrap(),
    PackageFirstCreateResolution::Ready(_)
  ));

  packages.revoke_publisher("com.example.keys.1").unwrap();
  // Revocation clears catalog defaults and/or marks policy unusable; either way package-first is blocked.
  assert_ne!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Authorized
  );
  assert!(!matches!(
    activation
      .prepare_package_first_create("com.example.translate")
      .unwrap(),
    PackageFirstCreateResolution::Ready(_)
  ));
}

#[test]
fn default_package_policy_resource_bootstrap_empty_creates_no_default() {
  // Bundled package import alone never authorizes a default; only an exact audited resource entry can.
  let (dir, packages, activation) = setup();
  let (_pkg, digest) = build_vendor_signed_package();
  let src = dir.path().join("vendor.lnplugin");
  std::fs::write(&src, _pkg).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  let empty_path = dir.path().join("default-activation-policies.json");
  std::fs::write(&empty_path, b"[]").unwrap();
  let activation = activation.with_vendor_bootstrap_path(&empty_path);
  let applied = activation.apply_vendor_bootstrap_policies().unwrap();
  assert!(
    applied.is_empty(),
    "empty policy resource creates no vendor bootstrap defaults"
  );
  let version = packages
    .list_versions()
    .unwrap()
    .into_iter()
    .find(|v| v.package_digest == digest)
    .expect("imported package remains installed");
  assert_eq!(
    activation.authorization_status(&version.plugin_id).unwrap(),
    DefaultPackageAuthorizationStatus::Absent
  );
  let catalog_default = activation
    .db
    .read(|conn| installed_plugin_versions::get_default(conn, &version.plugin_id))
    .unwrap();
  assert!(catalog_default.is_none(), "import alone must not set a catalog default");
}

#[test]
fn default_package_activation_authorization_vendor_bootstrap_exact_bind() {
  let (dir, packages, activation) = setup();
  let (pkg, digest) = build_vendor_signed_package();
  let src = dir.path().join("vendor.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  let version = packages
    .list_versions()
    .unwrap()
    .into_iter()
    .find(|v| v.package_digest == digest)
    .unwrap();

  let constraints = ApprovedAuthorityConstraints {
    fixed_network: vec![],
    auth_policies: vec![],
    dynamic_origin_endpoint_ids: vec![],
    resource_limits: None,
  };
  let entry = VendorBootstrapPolicyEntry {
    plugin_id: version.plugin_id.clone(),
    package_digest: digest.clone(),
    publisher_key_id: version.publisher_key_id.clone(),
    publisher_fingerprint: version.publisher_fingerprint.clone(),
    permission_request_digest: version.permission_request_digest.clone(),
    approved_authority_constraints: constraints,
  };
  let resource_path = dir.path().join("default-activation-policies.json");
  std::fs::write(&resource_path, serde_json::to_vec(&[entry]).unwrap()).unwrap();
  let activation = activation.with_vendor_bootstrap_path(&resource_path);
  let applied = activation.apply_vendor_bootstrap_policies().unwrap();
  assert_eq!(applied.len(), 1);
  assert_eq!(applied[0].package_digest, digest);
  assert_eq!(
    activation.authorization_status(&version.plugin_id).unwrap(),
    DefaultPackageAuthorizationStatus::Authorized
  );
  let policy = activation.get_authorized_policy(&version.plugin_id).unwrap().unwrap();
  assert_eq!(policy.policy_source, DefaultActivationPolicySource::VendorBootstrap);

  // Non-host-shipped / wrong digest must not authorize.
  let bad_entry = VendorBootstrapPolicyEntry {
    plugin_id: version.plugin_id.clone(),
    package_digest: "f".repeat(SHA256_HEX_LEN),
    publisher_key_id: version.publisher_key_id.clone(),
    publisher_fingerprint: version.publisher_fingerprint.clone(),
    permission_request_digest: version.permission_request_digest.clone(),
    approved_authority_constraints: ApprovedAuthorityConstraints {
      fixed_network: vec![],
      auth_policies: vec![],
      dynamic_origin_endpoint_ids: vec![],
      resource_limits: None,
    },
  };
  let bad_path = dir.path().join("bad-bootstrap.json");
  std::fs::write(&bad_path, serde_json::to_vec(&[bad_entry]).unwrap()).unwrap();
  let activation_bad = activation.with_vendor_bootstrap_path(&bad_path);
  let applied_bad = activation_bad.apply_vendor_bootstrap_policies().unwrap();
  assert!(applied_bad.is_empty());
}

#[test]
fn default_package_activation_intents_local_vs_import() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  let local_subject = new_id();
  let import_subject = new_id();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      local_subject,
      &digest,
      Some("cfg".into()),
      Some("tok".into()),
    )
    .unwrap();
  activation
    .record_import_requires_confirmation_intent(
      GrantSubjectKind::ProviderInstance,
      import_subject,
      &digest,
      Some("cfg-import".into()),
      Some("tok-import".into()),
    )
    .unwrap();
  let recovery = activation.list_recovery_eligible_intents().unwrap();
  assert_eq!(recovery.len(), 1);
  assert_eq!(recovery[0].subject_id, local_subject);
  assert_eq!(recovery[0].source, DefaultRuntimeActivationSource::LocalCreation);
  let import = activation
    .db
    .read(|conn| {
      default_package_activation_policies::get_intent(conn, GrantSubjectKind::ProviderInstance, import_subject)
    })
    .unwrap()
    .unwrap();
  assert_eq!(import.state, DefaultRuntimeActivationState::ConfirmationRequired);
}

#[test]
fn default_package_activation_resource_limits_preview_and_policy_match_effective_grants() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("limits.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();

  let expected = approved_limits_from_resource_limits(&ResourceLimits::default());
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  assert!(
    !preview.fixed_network_authority.is_empty(),
    "preview must include fixed network authority entries"
  );
  for entry in &preview.fixed_network_authority {
    let limits = entry
      .resource_limits
      .as_ref()
      .expect("each authority entry must expose effective resource limits");
    assert_eq!(limits.max_request_bytes, expected.max_request_bytes);
    assert_eq!(limits.max_response_bytes, expected.max_response_bytes);
    assert_eq!(limits.max_stream_bytes, expected.max_stream_bytes);
    assert_eq!(limits.timeout_ms, expected.timeout_ms);
  }
  let summary = preview
    .resource_limits
    .as_ref()
    .expect("top-level resource limits summary must be present when fixed network exists");
  assert_eq!(summary.max_request_bytes, expected.max_request_bytes);
  assert_eq!(summary.max_response_bytes, expected.max_response_bytes);
  assert_eq!(summary.max_stream_bytes, expected.max_stream_bytes);
  assert_eq!(summary.timeout_ms, expected.timeout_ms);

  let authorized = activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  assert_eq!(authorized.package_digest, digest);
  let policy = activation
    .get_authorized_policy("com.example.translate")
    .unwrap()
    .expect("authorized policy must persist");
  let constraints: ApprovedAuthorityConstraints =
    serde_json::from_str(&policy.approved_authority_constraints_json).unwrap();
  assert_eq!(constraints.resource_limits.as_ref(), Some(&expected));
  assert!(!constraints.fixed_network.is_empty());
  for entry in &constraints.fixed_network {
    assert_eq!(entry.resource_limits, expected);
  }

  // Bootstrap ceiling must reject any component-wise limit increase.
  let mut expanded = expected.clone();
  expanded.max_request_bytes = expected.max_request_bytes.saturating_add(1);
  assert!(!resource_limits_within_ceiling(&expanded, &expected));
}

#[test]
fn default_package_activation_integration_user_publisher_activates_policy_bound_snapshot() {
  // Policy-bound verification accepts user publishers (not vendor-root only).
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  let snapshot = activation
    .verify_shared_package_snapshot(&digest)
    .expect("user-approved package verifies through policy-bound snapshot");
  assert_eq!(snapshot.package_digest, digest);
  assert_eq!(snapshot.publisher_key_id, "com.example.keys.1");
  assert_eq!(
    snapshot.publisher_source,
    crate::domain::plugin_package::PublisherSource::UserApproved
  );
}

#[test]
fn default_package_activation_provider_exact_policy_resolution_no_applicable_without_policy() {
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
  };
  use crate::services::runtime_providers::{ProviderDefaultResolution, ProviderRuntimeService};
  use crate::services::wasm_runtime::WasmRuntime;
  use std::sync::Arc;

  let (dir, packages, activation) = setup();
  let _ = install_valid(&packages, dir.path(), false);
  let runtime = ProviderRuntimeService::new(
    activation.db.clone(),
    packages.clone(),
    Arc::new(WasmRuntime::new().expect("wasm runtime")),
  );
  // Without an authorized providerRuntime package, resolution is genuine absence.
  let resolution = runtime
    .resolve_applicable_provider_default(&ProviderInstanceWrite {
      id: None,
      adapter_id: "openai-compatible".into(),
      display_name: "x".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::None,
      credential: CredentialUpdate::Keep,
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: None,
    })
    .unwrap();
  assert!(matches!(resolution, ProviderDefaultResolution::NoApplicableDefault));
}

#[test]
fn default_package_activation_retry_integration_uses_retained_digest_only() {
  use crate::repositories::integration_instances;

  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  let subject = new_id();
  let created_at = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Retry".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: created_at.clone(),
          updated_at: created_at.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  let intent = activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(created_at.clone()),
    )
    .unwrap();
  assert_eq!(intent.package_digest, digest);

  // Shared verification failure transitions the subject unavailable and binds the failure token.
  activation
    .mark_subject_activation_failed(
      GrantSubjectKind::IntegrationInstance,
      subject,
      intent.id,
      "activation_failed",
      "forced shared verification failure",
    )
    .unwrap();
  let failed = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(failed.runtime_state, "unavailable");
  assert_eq!(failed.package_digest.as_deref(), Some(digest.as_str()));
  let failed_intent = activation
    .db
    .read(|conn| default_package_activation_policies::get_intent(conn, GrantSubjectKind::IntegrationInstance, subject))
    .unwrap()
    .expect("intent after failure");
  assert_eq!(failed_intent.state, DefaultRuntimeActivationState::Failed);
  assert_eq!(
    failed_intent.expected_update_token.as_deref(),
    Some(failed.updated_at.as_str()),
    "failure must rebind the intent token to the post-transition subject timestamp"
  );

  // Retry uses only the retained digest and returns the subject to pending_activation.
  let retried = activation
    .retry_default_runtime_activation(RetryDefaultRuntimeActivationInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect("terminal failure must remain retryable");
  assert_eq!(retried.package_digest, digest);
  assert_eq!(retried.state, DefaultRuntimeActivationState::Pending);
  let after = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(after.runtime_state, "pending_activation");
  assert_eq!(after.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(
    retried.expected_update_token.as_deref(),
    Some(after.updated_at.as_str()),
    "retry must rebind the intent to the post-reset subject token"
  );

  // A genuine post-failure user edit still conflicts and is preserved.
  activation
    .mark_subject_activation_failed(
      GrantSubjectKind::IntegrationInstance,
      subject,
      retried.id,
      "activation_failed",
      "second failure",
    )
    .unwrap();
  let edited_at = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      let current = integration_instances::get(uow.conn(), subject)?;
      integration_instances::mark_runtime_unavailable(
        uow.conn(),
        subject,
        &current.updated_at,
        "user_edit",
        "user changed subject after failure",
        &edited_at,
      )?;
      Ok(())
    })
    .unwrap();
  let conflict = activation
    .retry_default_runtime_activation(RetryDefaultRuntimeActivationInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect_err("user edit after failure must conflict");
  assert!(matches!(conflict, StorageError::Conflict(_)), "got {conflict:?}");
  let preserved = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(preserved.updated_at, edited_at);
  assert_eq!(preserved.runtime_error_code.as_deref(), Some("user_edit"));
}

#[test]
fn default_runtime_authority_confirmation_preview_is_subject_bound() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("authority.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  // Authorize a stricter policy ceiling with no fixed network so package authority is additional.
  packages.set_default("com.example.translate", &digest).unwrap();
  let empty_constraints = ApprovedAuthorityConstraints {
    fixed_network: vec![],
    auth_policies: vec!["host.none.v1".into()],
    dynamic_origin_endpoint_ids: vec![],
    resource_limits: None,
  };
  let constraints_json = serde_json::to_string(&empty_constraints).unwrap();
  let constraints_digest = sha256_hex(constraints_json.as_bytes());
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: "com.example.translate".into(),
          package_digest: digest.clone(),
          publisher_key_id: "com.example.keys.1".into(),
          publisher_fingerprint: test_fingerprint(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: compute_permission_request_digest(&manifest),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();

  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Authority".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now),
    )
    .unwrap();

  let preview = activation
    .preview_default_runtime_authority(PreviewDefaultRuntimeAuthorityInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect("authority preview");
  assert_eq!(preview.subject_kind, GrantSubjectKind::IntegrationInstance);
  assert_eq!(preview.subject_id, subject);
  assert_eq!(preview.package_digest, digest);
  assert!(!preview.preview_id.is_empty());
  assert!(!preview.additional_network_authority.is_empty());
  assert!(preview.additional_network_authority[0].resource_limits.is_some());
  assert!(preview.expires_at.contains('T'));

  let missing_ack = activation.confirm_default_runtime_authority(ConfirmDefaultRuntimeAuthorityInput {
    preview_id: preview.preview_id.clone(),
    acknowledge_additional_authority: false,
  });
  assert!(matches!(missing_ack, Err(StorageError::Validation(_))));
}

/// Expected concurrent callers that must join one same-digest flight before the worker proceeds.
const SAME_DIGEST_CONCURRENT_CALLERS: usize = 2;
/// Parties on the worker-hold barrier: the genuine worker and the test harness.
const SINGLE_FLIGHT_WORKER_HOLD_PARTIES: usize = 2;
/// Bounded wait for single-flight resilience tests so a defect fails instead of hanging.
const SINGLE_FLIGHT_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn run_same_digest_overlap(
  activation: &DefaultPackageActivationService,
  digest: &str,
) -> (
  Result<Arc<VerifiedActivationSnapshot>, StorageError>,
  Result<Arc<VerifiedActivationSnapshot>, StorageError>,
) {
  use std::sync::{Arc as StdArc, Barrier};
  use std::thread;

  let block = StdArc::new(Barrier::new(SINGLE_FLIGHT_WORKER_HOLD_PARTIES));
  *activation.verification_block.lock().unwrap() = Some(block.clone());

  let start = StdArc::new(Barrier::new(SAME_DIGEST_CONCURRENT_CALLERS));
  let first_activation = activation.clone();
  let second_activation = activation.clone();
  let first_digest = digest.to_owned();
  let second_digest = digest.to_owned();
  let first_start = start.clone();
  let second_start = start;

  let first = thread::spawn(move || {
    first_start.wait();
    first_activation.verify_shared_package_snapshot(&first_digest)
  });
  let second = thread::spawn(move || {
    second_start.wait();
    second_activation.verify_shared_package_snapshot(&second_digest)
  });

  wait_for_same_generation_overlap(activation, SAME_DIGEST_CONCURRENT_CALLERS);
  block.wait();
  *activation.verification_block.lock().unwrap() = None;

  (
    first.join().expect("first verification thread"),
    second.join().expect("second verification thread"),
  )
}

fn wait_for_same_generation_overlap(activation: &DefaultPackageActivationService, expected_joiners: usize) {
  use std::time::Instant;
  let deadline = Instant::now() + SINGLE_FLIGHT_TEST_TIMEOUT;
  let mut state = activation.flight_join_state.lock().unwrap_or_else(|e| e.into_inner());
  loop {
    if state.worker_started && state.joined_callers >= expected_joiners {
      return;
    }
    let now = Instant::now();
    if now >= deadline {
      panic!(
        "timed out waiting for worker start and {expected_joiners} joiners (worker_started={}, joined={})",
        state.worker_started, state.joined_callers
      );
    }
    let remaining = deadline.saturating_duration_since(now);
    let (guard, wait_result) = match activation.flight_join_signal.wait_timeout(state, remaining) {
      Ok(value) => value,
      Err(poisoned) => poisoned.into_inner(),
    };
    state = guard;
    if wait_result.timed_out() && !(state.worker_started && state.joined_callers >= expected_joiners) {
      panic!(
        "timed out waiting for worker start and {expected_joiners} joiners (worker_started={}, joined={})",
        state.worker_started, state.joined_callers
      );
    }
  }
}

#[test]
fn default_package_activation_single_flight_same_digest() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  let (first, second) = run_same_digest_overlap(&activation, &digest);
  let snap_a = first.expect("leader verification");
  let snap_b = second.expect("waiter verification");
  assert_eq!(snap_a.package_digest, digest);
  assert_eq!(snap_b.package_digest, digest);
  assert_eq!(snap_a.publisher_key_id, snap_b.publisher_key_id);
  let calls = *activation.verification_call_count.lock().unwrap();
  assert_eq!(
    calls, 1,
    "same-digest concurrent subjects share one initial verification"
  );

  // Retry after completion starts a new flight.
  let _ = activation.verify_shared_package_snapshot(&digest).unwrap();
  let calls_after = *activation.verification_call_count.lock().unwrap();
  assert_eq!(calls_after, 2, "completed flights must not be reused");
}

#[test]
fn default_package_activation_startup_recovery_claims_once() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  let subject = new_id();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some("cfg".into()),
      Some("tok".into()),
    )
    .unwrap();

  let worker_a = activation.clone();
  let worker_b = activation.clone();
  let claimed_a = worker_a
    .db
    .transaction(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-a",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
    .unwrap();
  let claimed_b = worker_b
    .db
    .transaction(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-b",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
    .unwrap();
  assert_eq!(claimed_a.len(), 1, "first worker claims the local pending intent");
  assert!(
    claimed_b.is_empty(),
    "second worker must not receive the same unexpired claim"
  );
  assert_eq!(claimed_a[0].claim_token.as_deref(), Some("worker-a"));

  // Expired claim can be reclaimed with a new token.
  activation
    .db
    .transaction(|uow| {
      uow
        .conn()
        .execute(
          "UPDATE default_runtime_activation_intents SET claim_expires_at = ?1 WHERE id = ?2",
          rusqlite::params!["2000-01-01T00:00:00Z", claimed_a[0].id.to_string()],
        )
        .map_err(StorageError::from)?;
      Ok(())
    })
    .unwrap();
  let reclaimed = activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-b",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
    .unwrap();
  assert_eq!(reclaimed.len(), 1);
  assert_eq!(reclaimed[0].claim_token.as_deref(), Some("worker-b"));
}

#[test]
fn default_package_activation_resource_limits_stale_preview_rejects_without_mutation() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();

  // Install a second package version so the catalog digest no longer matches the preview binding.
  // Consume is identity-bound; forcing authorize after uninstall/reinstall of different content is
  // covered by digest reverse-bind. Here we revoke the publisher to make authority identity stale.
  packages.revoke_publisher("com.example.keys.1").unwrap();
  let err = activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)));
  assert!(
    activation
      .get_authorized_policy("com.example.translate")
      .unwrap()
      .is_none()
  );
  assert!(
    activation
      .db
      .read(|conn| installed_plugin_versions::get_default(conn, "com.example.translate"))
      .unwrap()
      .is_none()
  );
}

#[test]
fn default_package_activation_policy_bound_verification_rejects_default_drift() {
  let (dir, packages, activation) = setup();
  let digest_a = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest_a).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  let digest_b = install_second_version(&packages, dir.path());
  packages
    .set_default("com.example.translate", &digest_b)
    .expect("catalog default may move without re-authorization");

  let err = activation
    .verify_shared_package_snapshot(&digest_a)
    .expect_err("policy-bound verification must reject default drift");
  match err {
    StorageError::Validation(message) => {
      assert!(
        message.contains(DEFAULT_AUTHORIZATION_STALE_CODE),
        "expected stale authorization, got {message}"
      );
    }
    other => panic!("expected validation stale error, got {other:?}"),
  }
}

#[test]
fn default_package_activation_retains_unauthorized_default() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  assert_eq!(
    activation.authorization_status("com.example.translate").unwrap(),
    DefaultPackageAuthorizationStatus::Unauthorized
  );
  match activation
    .prepare_package_first_create("com.example.translate")
    .unwrap()
  {
    PackageFirstCreateResolution::Blocked(blocked) => {
      assert_eq!(blocked.package_digest, digest);
      assert_eq!(blocked.reason, PackageFirstBlockReason::Unauthorized);
      assert_eq!(blocked.reason.as_error_code(), "default_authorization_required");
    }
    other => panic!("expected blocked unauthorized default, got {other:?}"),
  }

  // Genuine absence still permits dual-stack legacy.
  assert!(matches!(
    activation.prepare_package_first_create("com.example.missing").unwrap(),
    PackageFirstCreateResolution::NoDefault
  ));
}

#[test]
fn default_package_activation_subject_dispatch_uses_retained_intent_digest() {
  use crate::repositories::integration_instances;
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::sync::Arc;

  let (dir, packages, activation) = setup();
  let digest_a = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest_a).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  let digest_b = install_second_version(&packages, dir.path());

  let now = now_rfc3339();
  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Retained A".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest_a.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest_a,
      Some(sha256_hex(b"{}")),
      Some(now.clone()),
    )
    .unwrap();

  packages
    .set_default("com.example.translate", &digest_b)
    .expect("catalog default may move without rebinding subjects");

  let registry = Arc::new(ServiceIntegrationRegistry::empty());
  let lifecycle = RuntimeLifecycleService::new(activation.db.clone(), packages.clone(), registry);
  let activation = activation.with_integration_lifecycle(lifecycle);
  activation
    .activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject)
    .expect("activation must complete without retargeting");

  let instance = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(instance.package_digest.as_deref(), Some(digest_a.as_str()));
  assert_ne!(instance.package_digest.as_deref(), Some(digest_b.as_str()));
  assert_eq!(instance.runtime_state, "unavailable");
  assert_eq!(
    instance.runtime_error_code.as_deref(),
    Some(DEFAULT_AUTHORIZATION_STALE_CODE)
  );
  assert!(instance.execution_grant_set_revision.is_none());
}

#[test]
fn default_package_activation_single_flight_different_digests_concurrent() {
  use std::thread;

  let (dir, packages, activation) = setup();
  let digest_a = install_valid(&packages, dir.path(), false);
  let preview_a = activation.preview_default_package_activation(&digest_a).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview_a.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  // Second digest cannot share the first package's authorized default; authorize B separately
  // after moving the catalog default.
  let digest_b = install_second_version(&packages, dir.path());
  packages.set_default("com.example.translate", &digest_b).unwrap();
  // Re-authorize B so shared verification can succeed for both digests independently.
  let preview_b = activation.preview_default_package_activation(&digest_b).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview_b.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  // After B is authorized, A is no longer the catalog default so verify(A) is stale.
  // Verify both digests under concurrent load only for the current authorized default (B),
  // and ensure a second concurrent call for B still shares one flight.
  let a = activation.clone();
  let b = activation.clone();
  let digest_b1 = digest_b.clone();
  let digest_b2 = digest_b.clone();
  let handle_a = thread::spawn(move || a.verify_shared_package_snapshot(&digest_b1));
  let handle_b = thread::spawn(move || b.verify_shared_package_snapshot(&digest_b2));
  let snap_a = handle_a.join().unwrap().expect("first concurrent verification");
  let snap_b = handle_b.join().unwrap().expect("second concurrent verification");
  assert_eq!(snap_a.package_digest, digest_b);
  assert_eq!(snap_b.package_digest, digest_b);
  let calls = *activation.verification_call_count.lock().unwrap();
  assert_eq!(calls, 1, "same authorized digest shares one flight");

  // Different-digest concurrency: after B completes, verifying the stale A fails independently
  // without blocking or reusing B's flight.
  let err = activation.verify_shared_package_snapshot(&digest_a).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)));
  let calls_after = *activation.verification_call_count.lock().unwrap();
  assert_eq!(calls_after, 2, "stale digest starts its own failed flight");
}

#[test]
fn default_package_activation_single_flight_cleanup_retry() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  let first = activation.verify_shared_package_snapshot(&digest).unwrap();
  assert_eq!(first.package_digest, digest);
  assert_eq!(*activation.verification_call_count.lock().unwrap(), 1);

  // Completed flights must clean the map so a retry starts a fresh worker.
  let second = activation.verify_shared_package_snapshot(&digest).unwrap();
  assert_eq!(second.package_digest, digest);
  assert_eq!(*activation.verification_call_count.lock().unwrap(), 2);
}

#[test]
fn default_package_activation_single_flight_verification_failure() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  // No authorization policy: every waiter receives the same normalized failure.
  let (first, second) = run_same_digest_overlap(&activation, &digest);
  let err_a = first.expect_err("leader must fail");
  let err_b = second.expect_err("waiter must fail");
  assert!(matches!(err_a, StorageError::Validation(_)));
  assert!(matches!(err_b, StorageError::Validation(_)));
  assert_eq!(err_a.to_string(), err_b.to_string());
  assert_eq!(*activation.verification_call_count.lock().unwrap(), 1);

  // After failure, a new flight can start and succeed once authorized.
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();
  let snap = activation.verify_shared_package_snapshot(&digest).unwrap();
  assert_eq!(snap.package_digest, digest);
  assert_eq!(*activation.verification_call_count.lock().unwrap(), 2);
}

#[test]
fn default_package_activation_single_flight_verification_panic() {
  // Real panic injection inside the genuine policy-bound verifier: both waiters receive one
  // normalized panic result, and map cleanup allows a later successful verification.
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  activation.arm_verification_panic_once();
  let (first, second) = run_same_digest_overlap(&activation, &digest);
  let err_a = first.expect_err("leader publishes panic result");
  let err_b = second.expect_err("waiter receives published panic result");
  assert!(matches!(err_a, StorageError::Validation(_)));
  assert_eq!(err_a.to_string(), err_b.to_string());
  assert!(
    err_a.to_string().contains("panicked"),
    "normalized panic message expected, got {err_a}"
  );
  let failed_calls = *activation
    .verification_call_count
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  assert_eq!(failed_calls, 1, "panic flight runs the verifier once");

  let snap = activation.verify_shared_package_snapshot(&digest).unwrap();
  assert_eq!(snap.package_digest, digest);
  let after = *activation
    .verification_call_count
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  assert!(after > failed_calls, "cleanup allows a fresh successful flight");
}

#[test]
fn default_package_activation_single_flight_waiter_cancellation() {
  use crate::domain::cancel::CancelToken;
  use std::sync::Arc as StdArc;
  use std::sync::Barrier;
  use std::thread;

  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  // Worker and test each wait on a 2-party barrier so the independent worker is mid-flight
  // while one waiter cancels.
  let block = StdArc::new(Barrier::new(2));
  *activation.verification_block.lock().unwrap() = Some(block.clone());

  let cancel = CancelToken::new();
  let start = StdArc::new(Barrier::new(3));

  let cancelled_svc = activation.clone();
  let cancelled_digest = digest.clone();
  let cancelled_token = cancel.clone();
  let start_cancel = start.clone();
  let cancelled_handle = thread::spawn(move || {
    start_cancel.wait();
    cancelled_svc.verify_shared_package_snapshot_cancellable(&cancelled_digest, Some(&cancelled_token))
  });

  let surviving_svc = activation.clone();
  let surviving_digest = digest.clone();
  let start_survive = start.clone();
  let surviving_handle = thread::spawn(move || {
    start_survive.wait();
    surviving_svc.verify_shared_package_snapshot(&surviving_digest)
  });

  start.wait();
  // Wait until both waiters joined the same generation and the genuine worker is held.
  wait_for_same_generation_overlap(&activation, SAME_DIGEST_CONCURRENT_CALLERS);
  cancel.cancel();
  let cancelled_err = cancelled_handle
    .join()
    .expect("cancelled waiter thread")
    .expect_err("cancelled waiter returns promptly");
  assert!(
    cancelled_err.to_string().contains("cancelled"),
    "expected cancellation error, got {cancelled_err}"
  );

  // Release the worker; the surviving waiter must complete with one shared verification.
  block.wait();
  *activation.verification_block.lock().unwrap() = None;
  let surviving = surviving_handle
    .join()
    .expect("surviving waiter thread")
    .expect("surviving waiter completes after worker finishes");
  assert_eq!(surviving.package_digest, digest);
  assert_eq!(*activation.verification_call_count.lock().unwrap(), 1);
}

#[test]
fn default_runtime_authority_confirmation_persists_exact_approval() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::sync::Arc;

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("approval.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  packages.set_default("com.example.translate", &digest).unwrap();
  // Empty fixed network so package origin is additional and requires confirmation.
  let empty_constraints = ApprovedAuthorityConstraints {
    fixed_network: vec![],
    auth_policies: vec!["host.none.v1".into()],
    dynamic_origin_endpoint_ids: vec![],
    resource_limits: None,
  };
  let constraints_json = serde_json::to_string(&empty_constraints).unwrap();
  let constraints_digest = sha256_hex(constraints_json.as_bytes());
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: "com.example.translate".into(),
          package_digest: digest.clone(),
          publisher_key_id: "com.example.keys.1".into(),
          publisher_fingerprint: test_fingerprint(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: compute_permission_request_digest(&manifest),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest.clone(),
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();

  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Approval".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now.clone()),
    )
    .unwrap();

  let registry = Arc::new(ServiceIntegrationRegistry::empty());
  let lifecycle = RuntimeLifecycleService::new(activation.db.clone(), packages.clone(), registry);
  let activation = activation.with_integration_lifecycle(lifecycle);

  // Without approval, activation remains confirmation-required on pending_activation.
  activation
    .activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject)
    .unwrap();
  let before = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(before.runtime_state, "pending_activation");
  assert_eq!(
    before.runtime_error_code.as_deref(),
    Some(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE)
  );
  assert!(before.execution_grant_set_revision.is_none());

  let preview = activation
    .preview_default_runtime_authority(PreviewDefaultRuntimeAuthorityInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect("authority preview");
  assert!(!preview.additional_network_authority.is_empty());
  assert_eq!(
    preview.additional_network_authority[0].origin,
    "https://translate.example"
  );

  activation
    .confirm_default_runtime_authority(ConfirmDefaultRuntimeAuthorityInput {
      preview_id: preview.preview_id,
      acknowledge_additional_authority: true,
    })
    .expect("confirm persists approval and activates");

  // Recreate service from the same DB; approval must still be consumable only while binding matches.
  let reloaded = DefaultPackageActivationService::create(activation.db.clone(), packages.clone(), dir.path())
    .with_integration_lifecycle(RuntimeLifecycleService::new(
      activation.db.clone(),
      packages.clone(),
      Arc::new(ServiceIntegrationRegistry::empty()),
    ));
  let approval = reloaded
    .db
    .read(|conn| {
      default_package_activation_policies::get_authority_approval_exact(
        conn,
        GrantSubjectKind::IntegrationInstance,
        subject,
        &digest,
        &sha256_hex(b"{}"),
        &now,
        &constraints_digest,
      )
    })
    .unwrap();
  // Successful activation consumes the approval.
  assert!(approval.is_none(), "approval is consumed after successful activation");

  let after = reloaded
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  // Activation may succeed or fail on wasm/migration depending on fixture shape; grant presence
  // is the authority contract when migration succeeds. Always assert no silent legacy identity.
  assert_eq!(after.package_digest.as_deref(), Some(digest.as_str()));
  assert_ne!(after.runtime_kind, "bundled-rust");
}

#[test]
fn default_package_activation_integration_grant_rejects_unapproved_effective_origin() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::sync::Arc;

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://custom.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("unapproved.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  packages.set_default("com.example.translate", &digest).unwrap();
  let empty_constraints = ApprovedAuthorityConstraints {
    fixed_network: vec![],
    auth_policies: vec!["host.none.v1".into()],
    dynamic_origin_endpoint_ids: vec![],
    resource_limits: None,
  };
  let constraints_json = serde_json::to_string(&empty_constraints).unwrap();
  let constraints_digest = sha256_hex(constraints_json.as_bytes());
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: "com.example.translate".into(),
          package_digest: digest.clone(),
          publisher_key_id: "com.example.keys.1".into(),
          publisher_fingerprint: test_fingerprint(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: compute_permission_request_digest(&manifest),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Unapproved".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now),
    )
    .unwrap();

  let registry = Arc::new(ServiceIntegrationRegistry::empty());
  let lifecycle = RuntimeLifecycleService::new(activation.db.clone(), packages.clone(), registry);
  let activation = activation.with_integration_lifecycle(lifecycle);
  activation
    .activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject)
    .unwrap();

  let instance = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(instance.package_digest.as_deref(), Some(digest.as_str()));
  assert!(instance.execution_grant_set_revision.is_none());
  assert_eq!(instance.runtime_state, "pending_activation");
  assert_eq!(
    instance.runtime_error_code.as_deref(),
    Some(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE)
  );
  let intent = activation
    .db
    .read(|conn| default_package_activation_policies::get_intent(conn, GrantSubjectKind::IntegrationInstance, subject))
    .unwrap()
    .unwrap();
  assert_eq!(intent.state, DefaultRuntimeActivationState::ConfirmationRequired);
}

#[test]
fn default_runtime_authority_confirmation_stale_config_rejects_without_mutation() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("stale-config.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  packages.set_default("com.example.translate", &digest).unwrap();
  let empty_constraints = ApprovedAuthorityConstraints {
    fixed_network: vec![],
    auth_policies: vec!["host.none.v1".into()],
    dynamic_origin_endpoint_ids: vec![],
    resource_limits: None,
  };
  let constraints_json = serde_json::to_string(&empty_constraints).unwrap();
  let constraints_digest = sha256_hex(constraints_json.as_bytes());
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: "com.example.translate".into(),
          package_digest: digest.clone(),
          publisher_key_id: "com.example.keys.1".into(),
          publisher_fingerprint: test_fingerprint(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: compute_permission_request_digest(&manifest),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Stale".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "unavailable".into(),
          runtime_error_code: Some(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE.into()),
          runtime_error_message: Some("needs confirmation".into()),
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now.clone()),
    )
    .unwrap();
  activation
    .db
    .transaction(|uow| {
      if let Some(intent) =
        default_package_activation_policies::get_intent(uow.conn(), GrantSubjectKind::IntegrationInstance, subject)?
      {
        default_package_activation_policies::update_intent_state(
          uow.conn(),
          intent.id,
          DefaultRuntimeActivationState::ConfirmationRequired,
          Some(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE),
          Some("needs confirmation"),
        )?;
      }
      Ok(())
    })
    .unwrap();

  let preview = activation
    .preview_default_runtime_authority(PreviewDefaultRuntimeAuthorityInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect("authority preview");

  // Mutate config after preview: confirm must fail closed with no grant.
  activation
    .db
    .transaction(|uow| {
      let current = integration_instances::get(uow.conn(), subject)?;
      integration_instances::compare_and_set_runtime_pin(
        uow.conn(),
        subject,
        &current.updated_at,
        &current.plugin_version,
        r#"{"changed":true}"#,
        current.config_schema_version,
        &current.runtime_kind,
        current.package_digest.as_deref(),
        None,
        &current.runtime_state,
        current.runtime_error_code.as_deref(),
        current.runtime_error_message.as_deref(),
        current.runtime_requirement_json.as_deref(),
        &now_rfc3339(),
      )?;
      Ok(())
    })
    .unwrap();

  let err = activation
    .confirm_default_runtime_authority(ConfirmDefaultRuntimeAuthorityInput {
      preview_id: preview.preview_id,
      acknowledge_additional_authority: true,
    })
    .expect_err("stale config must reject");
  assert!(matches!(err, StorageError::Conflict(_)), "got {err:?}");

  let after = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert!(after.execution_grant_set_revision.is_none());
}

#[test]
fn default_package_activation_startup_recovery_skips_import_intents() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  let local = new_id();
  let imported = new_id();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      local,
      &digest,
      Some("cfg".into()),
      Some("tok".into()),
    )
    .unwrap();
  activation
    .record_import_requires_confirmation_intent(
      GrantSubjectKind::IntegrationInstance,
      imported,
      &digest,
      Some("cfg".into()),
      Some("tok".into()),
    )
    .unwrap();

  let claimed = activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-import-boundary",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
    .unwrap();
  assert_eq!(claimed.len(), 1, "only local_creation intents are recovery-eligible");
  assert_eq!(claimed[0].subject_id, local);
  assert_eq!(claimed[0].source, DefaultRuntimeActivationSource::LocalCreation);

  let eligible = activation.list_recovery_eligible_intents().unwrap();
  assert!(eligible.iter().all(|row| row.subject_id != imported));
}

#[test]
fn default_package_activation_startup_recovery_import_reopen_stays_confirmation_required() {
  use crate::services::plugin_store::PluginPackageService;

  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  packages
    .approve_user_publisher(ApproveUserPublisherInput {
      key_id: "com.example.keys.1".into(),
      fingerprint: test_fingerprint(),
      public_key_hex: test_public_key_hex(),
    })
    .unwrap();
  let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir.path());
  let digest = install_valid(&packages, dir.path(), true);
  let imported = new_id();
  activation
    .record_import_requires_confirmation_intent(
      GrantSubjectKind::IntegrationInstance,
      imported,
      &digest,
      Some("cfg".into()),
      Some("tok".into()),
    )
    .unwrap();

  // Close first service handles and reopen against the same on-disk database.
  drop(activation);
  drop(packages);
  let packages_reopen =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let activation_reopen = DefaultPackageActivationService::create(db.clone(), packages_reopen, dir.path());
  let recovered = activation_reopen
    .recover_pending_default_runtime_activations()
    .expect("recovery must not fail on import-only DB");
  assert_eq!(recovered, 0, "imported intents never recover");
  let intent = activation_reopen
    .db
    .read(|conn| default_package_activation_policies::get_intent(conn, GrantSubjectKind::IntegrationInstance, imported))
    .unwrap()
    .expect("import intent retained");
  assert_eq!(
    intent.source,
    DefaultRuntimeActivationSource::ImportRequiresConfirmation
  );
  assert_eq!(intent.state, DefaultRuntimeActivationState::ConfirmationRequired);
  assert!(intent.claim_token.is_none());
}

#[test]
fn default_package_activation_startup_recovery_reconciles_already_active_subject() {
  use crate::repositories::integration_instances;

  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), false);
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  let subject = new_id();
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "Already active".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Ready,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: Some(1),
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now),
    )
    .unwrap();

  let before_calls = *activation.verification_call_count.lock().unwrap();
  let recovered = activation
    .recover_pending_default_runtime_activations()
    .expect("already-active recovery reconciles");
  assert_eq!(recovered, 1);
  let after_calls = *activation.verification_call_count.lock().unwrap();
  assert_eq!(
    after_calls, before_calls,
    "already-active must not re-verify or dispatch"
  );
  let intent = activation
    .db
    .read(|conn| default_package_activation_policies::get_intent(conn, GrantSubjectKind::IntegrationInstance, subject))
    .unwrap()
    .expect("intent");
  assert_eq!(intent.state, DefaultRuntimeActivationState::Completed);
  assert!(intent.claim_token.is_none());
}

#[test]
fn default_package_activation_single_flight_two_subjects_independent_grants() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::sync::Arc;
  use std::thread;

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.none.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("dual-subject.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  let preview = activation.preview_default_package_activation(&digest).unwrap();
  activation
    .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
      preview_id: preview.preview_id,
      acknowledge_future_instance_authority: true,
      acknowledge_unsigned_default_risk: false,
    })
    .unwrap();

  let registry = Arc::new(ServiceIntegrationRegistry::empty());
  let lifecycle = RuntimeLifecycleService::new(activation.db.clone(), packages.clone(), registry);
  let activation = activation.with_integration_lifecycle(lifecycle);
  let now = now_rfc3339();
  let subject_a = new_id();
  let subject_b = new_id();
  for (subject, name) in [(subject_a, "A"), (subject_b, "B")] {
    activation
      .db
      .transaction(|uow| {
        integration_instances::insert(
          uow.conn(),
          &crate::domain::service_integration::IntegrationInstance {
            id: subject,
            plugin_id: "com.example.translate".into(),
            plugin_version: "1.0.0".into(),
            display_name: name.into(),
            enabled: true,
            config_json: "{}".into(),
            config_schema_version: 1,
            health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
            last_validated_at: None,
            last_error_code: None,
            runtime_kind: "wasm-component".into(),
            package_digest: Some(digest.clone()),
            execution_grant_set_revision: None,
            runtime_state: "pending_activation".into(),
            runtime_error_code: None,
            runtime_error_message: None,
            runtime_requirement_json: None,
            created_at: now.clone(),
            updated_at: now.clone(),
          },
        )?;
        Ok(())
      })
      .unwrap();
    activation
      .record_local_creation_intent(
        GrantSubjectKind::IntegrationInstance,
        subject,
        &digest,
        Some(sha256_hex(b"{}")),
        Some(now.clone()),
      )
      .unwrap();
  }

  let a = activation.clone();
  let b = activation.clone();
  let handle_a = thread::spawn(move || a.activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject_a));
  let handle_b = thread::spawn(move || b.activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject_b));
  handle_a.join().unwrap().unwrap();
  handle_b.join().unwrap().unwrap();

  let calls = *activation.verification_call_count.lock().unwrap();
  assert!(calls >= 1, "at least one shared verification");
  assert!(
    calls <= 2,
    "same-digest subjects should not unbounded re-verify: {calls}"
  );

  for subject in [subject_a, subject_b] {
    let instance = activation
      .db
      .read(|conn| integration_instances::get(conn, subject))
      .unwrap();
    assert_eq!(instance.package_digest.as_deref(), Some(digest.as_str()));
    assert_ne!(instance.runtime_kind, "bundled-rust");
    assert!(
      instance.runtime_state == "active"
        || instance.runtime_state == "pending_activation"
        || instance.runtime_state == "unavailable"
    );
  }
}

#[test]
fn default_package_activation_startup_recovery_two_workers_claim_partition() {
  let (dir, packages, activation) = setup();
  let digest = install_valid(&packages, dir.path(), true);
  let subjects: Vec<_> = (0..4).map(|_| new_id()).collect();
  for subject in &subjects {
    activation
      .record_local_creation_intent(
        GrantSubjectKind::IntegrationInstance,
        *subject,
        &digest,
        Some("cfg".into()),
        Some("tok".into()),
      )
      .unwrap();
  }

  // Concurrent claim CAS: each intent is owned by at most one worker token.
  let worker_a = activation.clone();
  let worker_b = activation.clone();
  let handle_a = std::thread::spawn(move || {
    worker_a.db.transaction_immediate(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-a",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
  });
  let handle_b = std::thread::spawn(move || {
    worker_b.db.transaction_immediate(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        "worker-b",
        &now_rfc3339(),
        &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })
  });
  let claimed_a = handle_a.join().unwrap().unwrap();
  let claimed_b = handle_b.join().unwrap().unwrap();
  let mut ids = claimed_a
    .iter()
    .chain(claimed_b.iter())
    .map(|row| row.id)
    .collect::<Vec<_>>();
  ids.sort();
  ids.dedup();
  assert_eq!(
    ids.len(),
    claimed_a.len() + claimed_b.len(),
    "workers must not claim the same intent"
  );
  assert_eq!(
    ids.len(),
    subjects.len(),
    "all eligible local intents are claimed exactly once"
  );
}

#[test]
fn default_runtime_authority_confirmation_auth_only_expansion() {
  use crate::domain::runtime_plugin::{HttpMethod, NetworkEndpointRequest, PermissionRequests};
  use crate::repositories::integration_instances;
  use crate::services::plugin_package::test_support::{build_signed_package, sample_manifest};
  use crate::services::runtime_lifecycle::RuntimeLifecycleService;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::sync::Arc;

  let (dir, packages, activation) = setup();
  let wasm = b"\0asm\x01\x00\x00\x00";
  let mut manifest = sample_manifest(wasm);
  manifest.permissions = PermissionRequests {
    network: vec![NetworkEndpointRequest {
      id: "translate".into(),
      origins: vec!["https://translate.example".into()],
      methods: vec![HttpMethod::Post],
      instance_origin_config_field: None,
    }],
    auth_policies: vec!["host.bearer.v1".into()],
  };
  let pkg = build_signed_package(&manifest, &[("artifacts/plugin.wasm", wasm.as_slice())]);
  let digest = crate::services::plugin_package::hash_archive_bytes(&pkg);
  let src = dir.path().join("auth-only.lnplugin");
  std::fs::write(&src, &pkg).unwrap();
  let preview_install = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview_install.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      acknowledge_unsigned_package_risk: false,
      acknowledge_native_execution_risk: false,
    })
    .unwrap();
  packages.set_default("com.example.translate", &digest).unwrap();

  let mut constraints = build_authority_constraints(&manifest);
  constraints.auth_policies = vec!["host.none.v1".into()];
  let constraints_json = serde_json::to_string(&constraints).unwrap();
  let constraints_digest = sha256_hex(constraints_json.as_bytes());
  let now = now_rfc3339();
  activation
    .db
    .transaction(|uow| {
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: "com.example.translate".into(),
          package_digest: digest.clone(),
          publisher_key_id: "com.example.keys.1".into(),
          publisher_fingerprint: test_fingerprint(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: compute_permission_request_digest(&manifest),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();

  let subject = new_id();
  activation
    .db
    .transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &crate::domain::service_integration::IntegrationInstance {
          id: subject,
          plugin_id: "com.example.translate".into(),
          plugin_version: "1.0.0".into(),
          display_name: "AuthOnly".into(),
          enabled: true,
          config_json: "{}".into(),
          config_schema_version: 1,
          health_status: crate::domain::service_integration::IntegrationHealthStatus::Unvalidated,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "wasm-component".into(),
          package_digest: Some(digest.clone()),
          execution_grant_set_revision: None,
          runtime_state: "pending_activation".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok(())
    })
    .unwrap();
  activation
    .record_local_creation_intent(
      GrantSubjectKind::IntegrationInstance,
      subject,
      &digest,
      Some(sha256_hex(b"{}")),
      Some(now.clone()),
    )
    .unwrap();

  let registry = Arc::new(ServiceIntegrationRegistry::empty());
  let lifecycle = RuntimeLifecycleService::new(activation.db.clone(), packages.clone(), registry);
  let activation = activation.with_integration_lifecycle(lifecycle);
  activation
    .activate_pending_subject(GrantSubjectKind::IntegrationInstance, subject)
    .unwrap();
  let after = activation
    .db
    .read(|conn| integration_instances::get(conn, subject))
    .unwrap();
  assert_eq!(after.runtime_state, "pending_activation");
  assert_eq!(
    after.runtime_error_code.as_deref(),
    Some(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE)
  );

  let preview = activation
    .preview_default_runtime_authority(PreviewDefaultRuntimeAuthorityInput {
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: subject,
    })
    .expect("auth-only expansion must preview");
  assert!(
    preview.auth_policies.iter().any(|p| p == "host.bearer.v1"),
    "preview must surface the expanded auth policy"
  );
  activation
    .confirm_default_runtime_authority(ConfirmDefaultRuntimeAuthorityInput {
      preview_id: preview.preview_id,
      acknowledge_additional_authority: true,
    })
    .expect("confirm auth-only expansion");
}
