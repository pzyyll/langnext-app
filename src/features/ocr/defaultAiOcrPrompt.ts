// ABOUTME: Default system/user prompt strings seeded for new AI OCR services.
// ABOUTME: Copied into the first template on create; user-editable afterward.

export const DEFAULT_AI_OCR_SYSTEM_TEMPLATE = `You are an OCR engine. Extract text from the user's image exactly as it appears.
Rules:
- Output only the recognized text. No preface, labels, or explanations.
- Preserve line breaks, spacing, and reading order when possible.
- Do not translate, summarize, correct, or invent content.
- If the image has no readable text, output an empty response.`;

export const DEFAULT_AI_OCR_USER_TEMPLATE = `Extract all text from the image.`;

/** Default display name for the first AI OCR prompt template. */
export const DEFAULT_AI_OCR_PROMPT_TEMPLATE_NAME = "Default";

/** App default temperature when the AI OCR temperature field is left empty. */
export const DEFAULT_AI_OCR_TEMPERATURE = 0.2;
