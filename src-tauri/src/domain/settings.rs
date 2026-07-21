// ABOUTME: Versioned portable application settings and proxy credential updates.
// ABOUTME: Proxy secrets stay out of the settings JSON document.
use crate::consts::{
  DEFAULT_OPEN_QUICK_TRANSLATE_BINDING, DEFAULT_REGION_SCREENSHOT_BINDING, DEFAULT_SCREENSHOT_OCR_BINDING,
  DOUBLE_CTRL_C_BINDING, SHORTCUT_DOUBLE_CTRL_C, SHORTCUT_OPEN_QUICK_TRANSLATE, SHORTCUT_REGION_SCREENSHOT,
  SHORTCUT_SCREENSHOT_OCR,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Global proxy mode for application networking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobalProxyMode {
  System,
  Custom,
}

impl GlobalProxyMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::System => "system",
      Self::Custom => "custom",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "system" => Ok(Self::System),
      "custom" => Ok(Self::Custom),
      other => Err(format!("invalid global proxy mode: {other}")),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
  pub proxy_mode: GlobalProxyMode,
  /// Custom proxy URL when mode is custom; credentials are not embedded.
  pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationPreferences {
  pub auto_detect_source: bool,
  pub preserve_formatting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDefinition {
  pub id: String,
  pub binding: String,
  /// When false the shortcut is not registered / ignored at runtime.
  #[serde(default = "default_shortcut_enabled")]
  pub enabled: bool,
}

fn default_shortcut_enabled() -> bool {
  true
}

/// Canonical defaults for known application shortcuts.
pub fn default_shortcuts() -> Vec<ShortcutDefinition> {
  vec![
    ShortcutDefinition {
      id: SHORTCUT_OPEN_QUICK_TRANSLATE.into(),
      binding: DEFAULT_OPEN_QUICK_TRANSLATE_BINDING.into(),
      enabled: true,
    },
    ShortcutDefinition {
      id: SHORTCUT_DOUBLE_CTRL_C.into(),
      binding: DOUBLE_CTRL_C_BINDING.into(),
      enabled: true,
    },
    ShortcutDefinition {
      id: SHORTCUT_REGION_SCREENSHOT.into(),
      binding: DEFAULT_REGION_SCREENSHOT_BINDING.into(),
      enabled: true,
    },
    ShortcutDefinition {
      id: SHORTCUT_SCREENSHOT_OCR.into(),
      binding: DEFAULT_SCREENSHOT_OCR_BINDING.into(),
      enabled: true,
    },
  ]
}

/// Merge stored entries with defaults so known ids always exist with valid values.
pub fn normalize_shortcuts(stored: Vec<ShortcutDefinition>) -> Vec<ShortcutDefinition> {
  let mut by_id: std::collections::HashMap<String, ShortcutDefinition> =
    stored.into_iter().map(|s| (s.id.clone(), s)).collect();

  let mut result = Vec::with_capacity(4);
  for default in default_shortcuts() {
    if let Some(mut found) = by_id.remove(&default.id) {
      if found.id == SHORTCUT_DOUBLE_CTRL_C {
        // Double Ctrl+C binding is fixed; only `enabled` is user-configurable.
        found.binding = DOUBLE_CTRL_C_BINDING.into();
      } else if found.binding.trim().is_empty() {
        found.binding = default.binding;
      }
      result.push(found);
    } else {
      result.push(default);
    }
  }
  result
}

/// Portable settings document stored in SQLite `app_settings.value_json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsV1 {
  pub schema_version: u32,
  pub ui_language: String,
  /// Null only before first authoritative Tauri initialization.
  pub theme: Option<String>,
  pub default_profile_id: Option<Uuid>,
  /// OCR service used for region-screenshot text recognition; null means unset.
  #[serde(default)]
  pub default_ocr_service_id: Option<Uuid>,
  pub translation: TranslationPreferences,
  pub shortcuts: Vec<ShortcutDefinition>,
  pub network: NetworkSettings,
}

impl AppSettingsV1 {
  pub const SCHEMA_VERSION: u32 = 1;

  pub fn default_document() -> Self {
    Self {
      schema_version: Self::SCHEMA_VERSION,
      ui_language: "en".into(),
      theme: None,
      default_profile_id: None,
      default_ocr_service_id: None,
      translation: TranslationPreferences {
        auto_detect_source: true,
        preserve_formatting: true,
      },
      shortcuts: default_shortcuts(),
      network: NetworkSettings {
        proxy_mode: GlobalProxyMode::System,
        proxy_url: None,
      },
    }
  }
}

/// IPC DTO with derived proxy credential flag; no secret or reference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsDto {
  #[serde(flatten)]
  pub settings: AppSettingsV1,
  pub proxy_has_credential: bool,
}

/// Proxy credential mutation. Secrets never print via Debug.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action", content = "value")]
pub enum ProxyCredentialUpdate {
  Keep,
  Replace(String),
  Clear,
}

impl std::fmt::Debug for ProxyCredentialUpdate {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Keep => write!(f, "Keep"),
      Self::Replace(_) => write!(f, "Replace([redacted])"),
      Self::Clear => write!(f, "Clear"),
    }
  }
}

/// Settings update input including optional proxy credential change.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsUpdate {
  pub settings: AppSettingsV1,
  pub proxy_credential: ProxyCredentialUpdate,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_settings_serialize() {
    let settings = AppSettingsV1::default_document();
    let json = serde_json::to_string(&settings).unwrap();
    assert!(json.contains("schemaVersion"));
    assert!(json.contains("proxyMode"));
    assert!(json.contains("defaultOcrServiceId"));
    let back: AppSettingsV1 = serde_json::from_str(&json).unwrap();
    assert_eq!(back, settings);
  }

  #[test]
  fn settings_deserialize_defaults_missing_ocr_service_id() {
    let json = r#"{
      "schemaVersion":1,
      "uiLanguage":"en",
      "theme":null,
      "defaultProfileId":null,
      "translation":{"autoDetectSource":true,"preserveFormatting":true},
      "shortcuts":[],
      "network":{"proxyMode":"system","proxyUrl":null}
    }"#;
    let parsed: AppSettingsV1 = serde_json::from_str(json).unwrap();
    assert_eq!(parsed.default_ocr_service_id, None);
  }

  #[test]
  fn normalize_shortcuts_fills_defaults_and_fixes_double_ctrl_c_binding() {
    let normalized = normalize_shortcuts(vec![ShortcutDefinition {
      id: crate::consts::SHORTCUT_DOUBLE_CTRL_C.into(),
      binding: "Alt+X".into(),
      enabled: false,
    }]);
    assert_eq!(normalized.len(), 4);
    let open = normalized
      .iter()
      .find(|s| s.id == crate::consts::SHORTCUT_OPEN_QUICK_TRANSLATE)
      .unwrap();
    assert_eq!(open.binding, crate::consts::DEFAULT_OPEN_QUICK_TRANSLATE_BINDING);
    assert!(open.enabled);
    let double = normalized
      .iter()
      .find(|s| s.id == crate::consts::SHORTCUT_DOUBLE_CTRL_C)
      .unwrap();
    assert_eq!(double.binding, crate::consts::DOUBLE_CTRL_C_BINDING);
    assert!(!double.enabled);
    let screenshot = normalized
      .iter()
      .find(|s| s.id == crate::consts::SHORTCUT_REGION_SCREENSHOT)
      .unwrap();
    assert_eq!(screenshot.binding, crate::consts::DEFAULT_REGION_SCREENSHOT_BINDING);
    assert!(screenshot.enabled);
    let screenshot_ocr = normalized
      .iter()
      .find(|s| s.id == crate::consts::SHORTCUT_SCREENSHOT_OCR)
      .unwrap();
    assert_eq!(screenshot_ocr.binding, crate::consts::DEFAULT_SCREENSHOT_OCR_BINDING);
    assert!(screenshot_ocr.enabled);
  }

  #[test]
  fn shortcut_enabled_defaults_when_missing_in_json() {
    let json = r#"{"id":"open-quick-translate","binding":"Ctrl+Alt+T"}"#;
    let parsed: ShortcutDefinition = serde_json::from_str(json).unwrap();
    assert!(parsed.enabled);
    assert_eq!(parsed.binding, "Ctrl+Alt+T");
  }

  #[test]
  fn proxy_credential_debug_redacts() {
    let update = ProxyCredentialUpdate::Replace("proxy-pass".into());
    assert!(!format!("{update:?}").contains("proxy-pass"));
  }
}
