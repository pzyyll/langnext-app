// ABOUTME: Typed application settings reads and updates with proxy credential orchestration.
// ABOUTME: Proxy secrets stay in the vault; value_json never embeds credentials.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, global_proxy_ref};
use crate::domain::settings::{
  AppSettingsDto, AppSettingsUpdate, AppSettingsV1, GlobalProxyMode, ProxyCredentialUpdate, ShortcutDefinition,
  normalize_shortcuts,
};
use crate::domain::time::new_id;
use crate::error::StorageError;
use crate::repositories::credential_operations::OwnerKind;
use crate::repositories::{app_credentials, app_settings, credential_operations, translation_profiles};
use crate::storage::Database;
use std::sync::Arc;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub struct SettingsService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
}

impl SettingsService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self { db, vault }
  }

  pub fn get(&self) -> Result<AppSettingsDto, StorageError> {
    self.db.read_snapshot(|conn| {
      let mut settings = app_settings::get(conn)?;
      settings.shortcuts = normalize_shortcuts(settings.shortcuts);
      let proxy_has_credential = app_credentials::get_global_proxy_ref(conn)?.is_some();
      Ok(AppSettingsDto {
        settings,
        proxy_has_credential,
      })
    })
  }

  pub fn update(&self, input: AppSettingsUpdate) -> Result<AppSettingsDto, StorageError> {
    let mut settings = input.settings;
    settings.shortcuts = normalize_shortcuts(settings.shortcuts);
    validate_settings_document(&settings)?;

    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::GlobalProxy, "global")?;

    match &input.proxy_credential {
      ProxyCredentialUpdate::Keep => {
        self.update_keep(settings)?;
      }
      ProxyCredentialUpdate::Replace(secret) => {
        if secret.is_empty() {
          return Err(StorageError::Validation("proxy credential must not be empty".into()));
        }
        self.replace_proxy_credential(&settings, secret)?;
      }
      ProxyCredentialUpdate::Clear => {
        self.clear_proxy_credential(&settings)?;
      }
    }

    self.get()
  }

  /// Atomic theme-only update inside one transaction.
  pub fn set_theme(&self, theme: Option<String>) -> Result<AppSettingsDto, StorageError> {
    if let Some(ref t) = theme {
      if t != "light" && t != "dark" {
        return Err(StorageError::Validation("theme must be light, dark, or null".into()));
      }
    }
    self.db.transaction(|uow| {
      let mut settings = app_settings::get(uow.conn())?;
      settings.theme = theme;
      app_settings::update(uow.conn(), &settings)?;
      let proxy_has_credential = app_credentials::get_global_proxy_ref(uow.conn())?.is_some();
      Ok(AppSettingsDto {
        settings,
        proxy_has_credential,
      })
    })
  }

  /// Atomic UI language-only update inside one transaction.
  pub fn set_ui_language(&self, ui_language: String) -> Result<AppSettingsDto, StorageError> {
    if ui_language != "en" && ui_language != "zh-CN" {
      return Err(StorageError::Validation("ui_language must be en or zh-CN".into()));
    }
    self.db.transaction(|uow| {
      let mut settings = app_settings::get(uow.conn())?;
      settings.ui_language = ui_language;
      app_settings::update(uow.conn(), &settings)?;
      let proxy_has_credential = app_credentials::get_global_proxy_ref(uow.conn())?.is_some();
      Ok(AppSettingsDto {
        settings,
        proxy_has_credential,
      })
    })
  }

  /// Atomic shortcuts-only update inside one transaction.
  pub fn set_shortcuts(&self, shortcuts: Vec<ShortcutDefinition>) -> Result<AppSettingsDto, StorageError> {
    let normalized = normalize_shortcuts(shortcuts);
    crate::shortcuts::validate_shortcuts(&normalized).map_err(StorageError::Validation)?;

    self.db.transaction(|uow| {
      let mut settings = app_settings::get(uow.conn())?;
      settings.shortcuts = normalized;
      app_settings::update(uow.conn(), &settings)?;
      settings.shortcuts = normalize_shortcuts(settings.shortcuts);
      let proxy_has_credential = app_credentials::get_global_proxy_ref(uow.conn())?.is_some();
      Ok(AppSettingsDto {
        settings,
        proxy_has_credential,
      })
    })
  }

  fn update_keep(&self, settings: AppSettingsV1) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      let conn = uow.conn();
      if credential_operations::get_for_owner(conn, OwnerKind::GlobalProxy, "global")?.is_some() {
        return Err(StorageError::CredentialBusy);
      }
      let current = app_settings::get(conn)?;
      let binding = app_credentials::get_global_proxy_ref(conn)?;
      let url_changed = current.network.proxy_url != settings.network.proxy_url;
      if url_changed && binding.is_some() {
        return Err(StorageError::Validation(
          "changing proxy URL requires Replace or Clear when a proxy credential exists".into(),
        ));
      }
      validate_default_profile(conn, settings.default_profile_id)?;
      app_settings::update(conn, &settings)?;
      Ok(())
    })
  }

  fn replace_proxy_credential(&self, settings: &AppSettingsV1, secret: &str) -> Result<(), StorageError> {
    let old_ref = self.db.read(app_credentials::get_global_proxy_ref)?;
    let op_id = new_id();
    let new_ref = global_proxy_ref(op_id);

    let prepared = self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        OwnerKind::GlobalProxy,
        "global",
        old_ref.as_deref(),
        Some(&new_ref),
      )
    })?;

    if let Err(e) = self.vault.set(&new_ref, secret) {
      let _ = self.db.transaction(|uow| {
        credential_operations::delete(uow.conn(), op_id)?;
        Ok(())
      });
      return Err(e);
    }

    let commit = self.db.transaction(|uow| {
      validate_default_profile(uow.conn(), settings.default_profile_id)?;
      app_settings::update(uow.conn(), settings)?;
      app_credentials::compare_and_set_global_proxy_ref(uow.conn(), old_ref.as_deref(), Some(&new_ref))?;
      let op = credential_operations::mark_db_committed(uow.conn(), op_id)?;
      Ok(op)
    });

    match commit {
      Ok(op) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(())
      }
      Err(e) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &prepared);
        Err(e)
      }
    }
  }

  fn clear_proxy_credential(&self, settings: &AppSettingsV1) -> Result<(), StorageError> {
    let old_ref = self.db.read(app_credentials::get_global_proxy_ref)?;
    let op_id = new_id();

    self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        OwnerKind::GlobalProxy,
        "global",
        old_ref.as_deref(),
        None,
      )?;
      Ok(())
    })?;

    let commit = self.db.transaction(|uow| {
      validate_default_profile(uow.conn(), settings.default_profile_id)?;
      app_settings::update(uow.conn(), settings)?;
      app_credentials::compare_and_set_global_proxy_ref(uow.conn(), old_ref.as_deref(), None)?;
      let op = credential_operations::mark_db_committed(uow.conn(), op_id)?;
      Ok(op)
    });

    match commit {
      Ok(op) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(())
      }
      Err(e) => {
        if let Ok(Some(op)) = self.db.read(|conn| credential_operations::get_by_id(conn, op_id)) {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        Err(e)
      }
    }
  }
}

/// Pure document validation (no database reads).
pub fn validate_settings_document(settings: &AppSettingsV1) -> Result<(), StorageError> {
  if settings.schema_version != AppSettingsV1::SCHEMA_VERSION {
    return Err(StorageError::Validation(format!(
      "unsupported settings schema_version {}",
      settings.schema_version
    )));
  }
  if let Some(theme) = &settings.theme {
    if theme != "light" && theme != "dark" {
      return Err(StorageError::Validation("theme must be light, dark, or null".into()));
    }
  }
  let normalized_shortcuts = normalize_shortcuts(settings.shortcuts.clone());
  crate::shortcuts::validate_shortcuts(&normalized_shortcuts).map_err(StorageError::Validation)?;
  match settings.network.proxy_mode {
    GlobalProxyMode::System => {
      if settings.network.proxy_url.is_some() {
        return Err(StorageError::Validation(
          "system proxy mode requires proxy_url to be null".into(),
        ));
      }
    }
    GlobalProxyMode::Custom => {
      let url = settings
        .network
        .proxy_url
        .as_deref()
        .ok_or_else(|| StorageError::Validation("custom proxy mode requires proxy_url".into()))?;
      validate_proxy_url(url)?;
    }
  }
  Ok(())
}

/// Connection-scoped default profile existence check.
pub fn validate_default_profile(conn: &rusqlite::Connection, profile_id: Option<Uuid>) -> Result<(), StorageError> {
  if let Some(profile_id) = profile_id {
    translation_profiles::get(conn, profile_id).map_err(|e| match e {
      StorageError::NotFound(_) => StorageError::Validation(format!("default_profile_id {profile_id} does not exist")),
      other => other,
    })?;
  }
  Ok(())
}

/// Full settings validation against a live database (document + default profile).
pub fn validate_settings(settings: &AppSettingsV1, db: &Database) -> Result<(), StorageError> {
  validate_settings_document(settings)?;
  db.read(|conn| validate_default_profile(conn, settings.default_profile_id))
}

pub fn validate_proxy_url(raw: &str) -> Result<(), StorageError> {
  let url = Url::parse(raw).map_err(|e| StorageError::Validation(format!("invalid proxy URL: {e}")))?;
  if !url.username().is_empty() || url.password().is_some() {
    return Err(StorageError::Validation("proxy URL must not contain userinfo".into()));
  }
  if url.query().is_some() || url.fragment().is_some() {
    return Err(StorageError::Validation(
      "proxy URL must not contain query or fragment".into(),
    ));
  }
  match url.scheme() {
    "http" | "https" | "socks5" | "socks5h" => Ok(()),
    other => Err(StorageError::Validation(format!("unsupported proxy scheme: {other}"))),
  }
}
