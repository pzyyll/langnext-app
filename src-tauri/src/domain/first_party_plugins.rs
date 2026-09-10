// ABOUTME: Canonical first-party package identity set and membership checks.
// ABOUTME: Store approval, release verification, and service constants share this owner.

/// Google Web (GTX / HTTPS proxy) first-party package id.
pub const GOOGLE_TRANSLATE_WEB_PLUGIN_ID: &str = "com.langnext.google-translate-web";
/// Edge TTS first-party package id.
pub const EDGE_TTS_PLUGIN_ID: &str = "com.langnext.edge-tts";
/// Google Cloud first-party package id.
pub const GOOGLE_CLOUD_PLUGIN_ID: &str = "com.langnext.google-cloud";
/// OpenAI-compatible provider first-party package id.
pub const OPENAI_COMPATIBLE_PLUGIN_ID: &str = "com.langnext.provider.openai-compatible";
/// OpenAI Responses provider first-party package id.
pub const OPENAI_RESPONSES_PLUGIN_ID: &str = "com.langnext.provider.openai-responses";
/// Anthropic provider first-party package id.
pub const ANTHROPIC_PLUGIN_ID: &str = "com.langnext.provider.anthropic";
/// Gemini provider first-party package id.
pub const GEMINI_PLUGIN_ID: &str = "com.langnext.provider.gemini";
/// DeepSeek provider first-party package id.
pub const DEEPSEEK_PLUGIN_ID: &str = "com.langnext.provider.deepseek";
/// PaddleOCR first-party package id.
pub const PADDLEOCR_PLUGIN_ID: &str = "com.langnext.paddleocr";
/// Baidu OCR first-party package id.
pub const BAIDU_OCR_PLUGIN_ID: &str = "com.langnext.baidu-ocr";

/// Canonical first-party package IDs. Non-built-in content cannot claim any member.
pub const FIRST_PARTY_PLUGIN_IDS: &[&str] = &[
  GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
  EDGE_TTS_PLUGIN_ID,
  GOOGLE_CLOUD_PLUGIN_ID,
  OPENAI_COMPATIBLE_PLUGIN_ID,
  OPENAI_RESPONSES_PLUGIN_ID,
  ANTHROPIC_PLUGIN_ID,
  GEMINI_PLUGIN_ID,
  DEEPSEEK_PLUGIN_ID,
  PADDLEOCR_PLUGIN_ID,
  BAIDU_OCR_PLUGIN_ID,
];

/// True when `plugin_id` is a reserved first-party package identity.
pub fn is_first_party_plugin_id(plugin_id: &str) -> bool {
  FIRST_PARTY_PLUGIN_IDS.contains(&plugin_id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  #[test]
  fn first_party_ids_are_unique_and_reserved() {
    let set: HashSet<&str> = FIRST_PARTY_PLUGIN_IDS.iter().copied().collect();
    assert_eq!(set.len(), FIRST_PARTY_PLUGIN_IDS.len());
    assert_eq!(FIRST_PARTY_PLUGIN_IDS.len(), 10);
    for id in FIRST_PARTY_PLUGIN_IDS {
      assert!(is_first_party_plugin_id(id));
      assert!(id.starts_with("com.langnext."));
    }
    assert!(!is_first_party_plugin_id("com.example.unsigned"));
    assert!(!is_first_party_plugin_id(BAIDU_OCR_PLUGIN_ID.trim_end_matches("-ocr")));
  }
}
