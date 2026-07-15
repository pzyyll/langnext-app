// ABOUTME: Language detector domain contract: config, IPC input/result, and strict LLM-output parser.
// ABOUTME: Only LLM-backed detection exists today; the tagged enum leaves room for Google/Microsoft providers.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Language ids the detector may return. Keep in sync with the system prompt and the parser.
pub const SUPPORTED_LANGUAGES: &[&str] = &[
	"zh", "en", "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "he", "hi", "hr", "hu", "id", "it",
	"ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "th", "tl",
	"tr", "uk", "ur", "vi",
];

/// Return the supported language id slice (used by prompts and validation).
pub fn supported_languages() -> &'static [&'static str] {
	SUPPORTED_LANGUAGES
}

/// Tagged detector configuration. `type` selects the backend; only `llm` exists today.
///
/// Future non-model providers (Google, Microsoft, …) add variants here without changing
/// callers that match on the enum. The `llm` variant carries an optional explicit model id;
/// `None` means “use the profile primary model at detect time”.
///
/// `rename_all` sets the discriminant (`type`) casing; `rename_all_fields` sets the variant
/// field casing so `model_id` serializes as `modelId`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LanguageDetectorConfig {
	Llm {
		/// Provider model id to use for detection. `None` falls back to the profile primary.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		model_id: Option<Uuid>,
	},
}

impl LanguageDetectorConfig {
	/// The detector type discriminant this config carries.
	pub fn detector_type(&self) -> DetectorType {
		match self {
			Self::Llm { .. } => DetectorType::Llm,
		}
	}

	/// Model id explicitly configured for the LLM detector, if any.
	pub fn llm_model_id(&self) -> Option<Uuid> {
		match self {
			Self::Llm { model_id } => *model_id,
		}
	}
}

/// Detector backend that produced a `DetectLanguageResult`. Mirrors `LanguageDetectorConfig` tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectorType {
	Llm,
}

impl DetectorType {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Llm => "llm",
		}
	}
}

/// Frontend request to detect the language of `text`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectLanguageInput {
	/// Source text to classify (not persisted).
	pub text: String,
	/// Default LLM model used when no profile is selected. Ignored when a profile is present
	/// and its `languageDetection` configures an explicit model.
	#[serde(default)]
	pub model_id: Option<Uuid>,
	/// Profile supplying detector config and the primary model fallback.
	#[serde(default)]
	pub profile_id: Option<Uuid>,
}

/// Detection outcome returned to the WebView. Soft failures carry `ok = false` + `error_code`.
///
/// No confidence score is synthesized: either a supported code is parsed or the result is a
/// bounded soft failure.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectLanguageResult {
	pub ok: bool,
	/// Detected supported language id (e.g. `zh`). `None` on soft failure.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub language_id: Option<String>,
	/// Detector backend that produced this result.
	pub detector_type: DetectorType,
	/// Model used for detection (LLM variant). `None` when no model was reached.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub model_id: Option<Uuid>,
	/// Wall-clock duration of the detector call in milliseconds.
	pub latency_ms: u64,
	/// Bounded failure code when `ok` is false.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error_code: Option<String>,
	/// Human-readable status or error message (secret-free).
	pub message: String,
}

/// Soft failure code when the user (or UI) cancels an in-flight detection.
pub const DETECT_CANCELLED_CODE: &str = "cancelled";

impl DetectLanguageResult {
	pub fn success(language_id: &str, model_id: Option<Uuid>, latency_ms: u64) -> Self {
		Self {
			ok: true,
			language_id: Some(language_id.to_string()),
			detector_type: DetectorType::Llm,
			model_id,
			latency_ms,
			error_code: None,
			message: "ok".into(),
		}
	}

	/// Soft failure after a model was selected (transport/parse failure). Records the model.
	pub fn failure_with_model(
		error_code: impl Into<String>,
		message: impl Into<String>,
		latency_ms: u64,
		model_id: Option<Uuid>,
	) -> Self {
		Self {
			ok: false,
			language_id: None,
			detector_type: DetectorType::Llm,
			model_id,
			latency_ms,
			error_code: Some(error_code.into()),
			message: message.into(),
		}
	}

	/// Soft failure before any model was reached (validation / credential). No model id.
	pub fn failure(error_code: impl Into<String>, message: impl Into<String>, latency_ms: u64) -> Self {
		Self::failure_with_model(error_code, message, latency_ms, None)
	}

	pub fn cancelled(latency_ms: u64) -> Self {
		Self::failure_with_model(DETECT_CANCELLED_CODE, "Language detection cancelled", latency_ms, None)
	}
}

/// Strictly parse a supported language code from raw LLM output.
///
/// Allows one layer of surrounding quotes/backticks and a single trailing/leading period, then
/// requires a bare lowercase token that exactly matches a supported id. Long explanatory text
/// (whitespace, sentences) is never guessed from — the candidate must be a short bare code.
pub fn parse_language_code(raw: &str) -> Option<&'static str> {
	let candidate = strip_wrapping(raw).to_lowercase();
	if candidate.is_empty() {
		return None;
	}
	// No internal whitespace and a short length cap: rejects prose like "The language is zh."
	if candidate.chars().any(|c| c.is_whitespace()) {
		return None;
	}
	if candidate.len() > 8 {
		return None;
	}
	SUPPORTED_LANGUAGES.iter().copied().find(|lang| **lang == candidate)
}

/// Trim and strip one layer of quote/backtick wrapping plus a single trailing/leading period.
///
/// Order matters: `"es".` must reduce to `es`. We peel off at most one quote pair and one
/// period total, then trim surrounding whitespace again. No multi-layer peeling is performed.
fn strip_wrapping(raw: &str) -> &str {
	let s = raw.trim();
	// Strip one trailing period first so `"es".` becomes `"es"`, then peel the quotes.
	let s = s.strip_suffix('.').unwrap_or(s);
	let s = strip_matching_quotes(s);
	// A leading period (rare) is peeled only after quotes are gone.
	let s = s.strip_prefix('.').unwrap_or(s);
	s.trim()
}

/// Remove one matching pair of surrounding `"`, `'`, or backtick characters.
fn strip_matching_quotes(s: &str) -> &str {
	let bytes = s.as_bytes();
	if bytes.len() < 2 {
		return s;
	}
	let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
	let matches = (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') || (first == b'`' && last == b'`');
	if matches {
		// Safe: first/last are single ASCII bytes.
		&s[1..s.len() - 1]
	} else {
		s
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_bare_lowercased_codes() {
		assert_eq!(parse_language_code("zh"), Some("zh"));
		assert_eq!(parse_language_code("en"), Some("en"));
		assert_eq!(parse_language_code("ja"), Some("ja"));
	}

	#[test]
	fn parses_uppercase_and_surrounding_whitespace() {
		assert_eq!(parse_language_code("  ZH  "), Some("zh"));
		assert_eq!(parse_language_code("\tKo\n"), Some("ko"));
	}

	#[test]
	fn strips_single_and_double_quotes_and_backticks() {
		assert_eq!(parse_language_code("\"en\""), Some("en"));
		assert_eq!(parse_language_code("'fr'"), Some("fr"));
		assert_eq!(parse_language_code("`de`"), Some("de"));
	}

	#[test]
	fn strips_trailing_period() {
		assert_eq!(parse_language_code("zh."), Some("zh"));
		assert_eq!(parse_language_code("\"es\"."), Some("es"));
		assert_eq!(parse_language_code("`ja`."), Some("ja"));
	}

	#[test]
	fn rejects_unsupported_codes() {
		assert_eq!(parse_language_code("xx"), None);
		assert_eq!(parse_language_code("english"), None);
		assert_eq!(parse_language_code("zho"), None);
		assert_eq!(parse_language_code(""), None);
		assert_eq!(parse_language_code("   "), None);
	}

	#[test]
	fn rejects_explanatory_prose() {
		// Must not guess a code out of a sentence.
		assert_eq!(parse_language_code("The language is zh."), None);
		assert_eq!(parse_language_code("I think it is Chinese"), None);
		assert_eq!(parse_language_code("language: zh"), None);
	}

	#[test]
	fn rejects_nested_or_multi_layer_wrapping() {
		// Only one layer is stripped; extra quotes remain and fail the bare-token match.
		assert_eq!(parse_language_code("\"`en`\""), None);
		assert_eq!(parse_language_code("''zh''"), None);
	}

	#[test]
	fn rejects_overlong_candidate() {
		// 9 chars, no spaces — over the bare-code cap.
		assert_eq!(parse_language_code("abcdefghi"), None);
	}

	#[test]
	fn supported_languages_match_contract() {
		assert_eq!(
			supported_languages(),
			&[
				"zh", "en", "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "he", "hi", "hr", "hu", "id",
				"it", "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta",
				"th", "tl", "tr", "uk", "ur", "vi",
			],
		);
	}

	#[test]
	fn config_round_trip_llm_with_model() {
		let cfg = LanguageDetectorConfig::Llm {
			model_id: Some(uuid::Uuid::nil()),
		};
		let json = serde_json::to_value(&cfg).unwrap();
		assert_eq!(json["type"], "llm");
		assert_eq!(
			json.get("modelId").and_then(|v| v.as_str()),
			Some(uuid::Uuid::nil().to_string().as_str())
		);
		let back: LanguageDetectorConfig = serde_json::from_value(json).unwrap();
		assert_eq!(back, cfg);
		assert_eq!(back.detector_type(), DetectorType::Llm);
	}
	#[test]
	fn config_llm_without_model_omits_field() {
		let cfg = LanguageDetectorConfig::Llm { model_id: None };
		let json = serde_json::to_value(&cfg).unwrap();
		assert_eq!(json["type"], "llm");
		assert!(json.get("modelId").is_none() || json["modelId"].is_null());
		let back: LanguageDetectorConfig = serde_json::from_value(json).unwrap();
		assert_eq!(back.llm_model_id(), None);
		let explicit_null: LanguageDetectorConfig =
			serde_json::from_value(serde_json::json!({ "type": "llm", "modelId": null })).unwrap();
		assert_eq!(explicit_null.llm_model_id(), None);
	}

	#[test]
	fn result_success_and_failure_shapes() {
		let ok = DetectLanguageResult::success("zh", Some(uuid::Uuid::nil()), 12);
		assert!(ok.ok);
		assert_eq!(ok.language_id.as_deref(), Some("zh"));
		assert_eq!(ok.detector_type, DetectorType::Llm);
		assert_eq!(ok.error_code, None);

		let fail = DetectLanguageResult::failure("invalid_response", "no code", 3);
		assert!(!fail.ok);
		assert_eq!(fail.error_code.as_deref(), Some("invalid_response"));
		assert_eq!(fail.language_id, None);
		assert_eq!(fail.model_id, None);

		let cancelled = DetectLanguageResult::cancelled(5);
		assert_eq!(cancelled.error_code.as_deref(), Some(DETECT_CANCELLED_CODE));
		assert_eq!(cancelled.model_id, None);
	}

	#[test]
	fn cancelled_code_is_stable() {
		assert_eq!(DETECT_CANCELLED_CODE, "cancelled");
	}
}
