// ABOUTME: Frontend adapter options used when creating provider instances.
// ABOUTME: Mirrors the backend metadata catalog until catalog IPC is available.

export type AdapterOption = {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
};

/** Confirmed adapter creation options matching the backend catalog. */
export const ADAPTER_OPTIONS: readonly AdapterOption[] = [
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
  },
] as const;

/** Look up the documented default Base URL for an adapter ID. */
export function getDefaultBaseUrl(adapterId: string): string | null {
  const match = ADAPTER_OPTIONS.find((option) => option.id === adapterId);
  return match?.defaultBaseUrl ?? null;
}

/** Look up a human-readable adapter label; falls back to the raw ID. */
export function getAdapterLabel(adapterId: string): string {
  const match = ADAPTER_OPTIONS.find((option) => option.id === adapterId);
  return match?.label ?? adapterId;
}
