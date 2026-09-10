// ABOUTME: Pins the structural outcome of every committed `.lnplugin` conformance fixture.
// ABOUTME: Fails closed when archive validation silently accepts a rejected fixture.

#![cfg(test)]

use crate::domain::plugin_catalog::{PluginLoadErrorCode, PluginSource};
use crate::services::plugin_loader::PluginLoader;
use std::path::{Path, PathBuf};

/// Expected structural outcome for one committed fixture archive.
enum Expected {
  /// The archive loads. The payload names the plugin it must resolve to.
  Accepted { plugin_id: &'static str },
  /// The archive is rejected with this exact closed error code.
  Rejected { code: PluginLoadErrorCode },
}

const FIXTURES: &[(&str, Expected)] = &[
  (
    "valid-archive.lnplugin",
    Expected::Accepted {
      plugin_id: "com.example.translate",
    },
  ),
  (
    "llm-provider-valid.lnplugin",
    Expected::Accepted {
      plugin_id: "langnext.conformance.llm-provider",
    },
  ),
  (
    "permission-expanding.lnplugin",
    Expected::Accepted {
      plugin_id: "com.example.translate",
    },
  ),
  (
    "legacy-signature-entry.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::UndeclaredFile,
    },
  ),
  (
    "legacy-publisher-key.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::UndeclaredFile,
    },
  ),
  (
    "traversal.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::PathInvalid,
    },
  ),
  (
    "symlink.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::SymlinkRejected,
    },
  ),
  (
    "duplicate-path.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::DuplicatePath,
    },
  ),
  (
    "undeclared-file.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::UndeclaredFile,
    },
  ),
  (
    "missing-indexed-file.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::UndeclaredFile,
    },
  ),
  (
    "locale-tamper.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::DigestMismatch,
    },
  ),
  (
    "incompatible.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::CompatibilityRejected,
    },
  ),
  (
    "target-incompatible.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::CompatibilityRejected,
    },
  ),
  (
    "oversized-entry.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::EntryTooLarge,
    },
  ),
  (
    "zip-bomb.lnplugin",
    Expected::Rejected {
      code: PluginLoadErrorCode::ZipBomb,
    },
  ),
];

fn fixtures_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime-plugins/conformance/fixtures/packages")
}

fn loader(cache_root: &Path) -> PluginLoader {
  PluginLoader::new(cache_root.join("plugin-cache"))
}

#[test]
fn committed_archive_fixtures_keep_their_expected_outcome() {
  let cache = tempfile::tempdir().unwrap();
  let loader = loader(cache.path());
  let dir = fixtures_dir();
  let mut missing = Vec::new();
  for (name, expected) in FIXTURES {
    let path = dir.join(name);
    if !path.is_file() {
      missing.push(*name);
      continue;
    }
    match expected {
      Expected::Accepted { plugin_id } => {
        let loaded = loader
          .load_archive(PluginSource::BuiltIn, &path)
          .unwrap_or_else(|error| panic!("{name} must load, got {error}"));
        assert_eq!(&loaded.descriptor.plugin_id, plugin_id, "fixture {name}");
        assert!(
          loaded.snapshot_dir.is_dir(),
          "fixture {name} must publish an immutable snapshot"
        );
      }
      Expected::Rejected { code } => {
        let error = loader
          .load_archive(PluginSource::BuiltIn, &path)
          .expect_err(&format!("{name} must be rejected"));
        assert_eq!(&error.code, code, "fixture {name}: {error}");
      }
    }
  }
  assert!(missing.is_empty(), "committed fixtures are missing: {missing:?}");
}

/// The fixture directory carries no key material, signature file, or publisher declaration.
#[test]
fn fixture_directory_has_no_trust_material() {
  let dir = fixtures_dir();
  let mut offenders = Vec::new();
  for entry in std::fs::read_dir(&dir).unwrap() {
    let entry = entry.unwrap();
    let name = entry.file_name().to_string_lossy().to_string();
    if entry.path().is_dir() {
      offenders.push(format!("{name}/ (directory)"));
      continue;
    }
    if name.ends_with(".hex") || name.contains("signing") || name.contains("public-key") {
      offenders.push(name);
    }
  }
  assert!(
    offenders.is_empty(),
    "no signing keys or trust material may live in the fixture directory: {offenders:?}"
  );
}
