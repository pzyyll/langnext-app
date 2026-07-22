// ABOUTME: Strict translation prompt template placeholder rendering.
// ABOUTME: Supports plan placeholders and legacy Rust template variable names.
const PLACEHOLDER_SOURCE_LANG = "sourceLang";
const PLACEHOLDER_TARGET_LANG = "targetLang";
const PLACEHOLDER_TEXT = "text";
const LEGACY_SOURCE_LANG = "source_language";
const LEGACY_TARGET_LANG = "target_language";

export function renderPromptTemplate(template: string, sourceLang: string, targetLang: string, text: string): string {
  let out = "";
  let rest = template;
  while (true) {
    const start = rest.indexOf("{{");
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) {
      out += "{{";
      out += after;
      break;
    }
    const variable = after.slice(0, end).trim();
    switch (variable) {
      case PLACEHOLDER_SOURCE_LANG:
      case LEGACY_SOURCE_LANG:
        out += sourceLang;
        break;
      case PLACEHOLDER_TARGET_LANG:
      case LEGACY_TARGET_LANG:
        out += targetLang;
        break;
      case PLACEHOLDER_TEXT:
        out += text;
        break;
      default:
        out += `{{${variable}}}`;
        break;
    }
    rest = after.slice(end + 2);
  }
  return out;
}

export function buildDefaultTranslateSystemPrompt(sourceLang: string, targetLang: string): string {
  return (
    `You are a professional translation engine. Translate the user's text from ${sourceLang} to ${targetLang}.\n` +
    "Rules:\n" +
    "- Output only the translated text, with no preface, labels, quotes, or explanations.\n" +
    "- Preserve meaning, tone, and formatting (line breaks, lists, punctuation) when possible.\n" +
    "- If the source is already in the target language, return it unchanged.\n" +
    "- Do not invent content that is not present in the source."
  );
}
