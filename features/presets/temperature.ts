import type { ProtocolId } from "../../modules/ai/contracts/protocol";

const STANDARD_TEMPERATURE_MAX = 2;
const CLAUDE_TEMPERATURE_MAX = 1;

export type ModelTemperatureLimit = number | "omit" | "unknown";

export interface TemperaturePolicy {
  maximum: number | null;
  requiresOmission: boolean;
  hasUnknownLimit: boolean;
}

/** Official API limits only. A compatible wire format does not identify the service. */
export function modelTemperatureLimit(
  origin: string | null,
  protocolId: ProtocolId,
  modelKey: string,
): ModelTemperatureLimit {
  const model = modelKey.toLowerCase();
  const isOpenAiFormat = protocolId === "openai-compatible" || protocolId === "openai-responses";

  if (origin === "https://api.openai.com" && isOpenAiFormat) {
    // These documented families do not support custom sampling on these endpoints.
    if (/^(?:gpt-6\.2-(?:astra|sol)|o[134])(?:-|$)/.test(model)) return "omit";
    return STANDARD_TEMPERATURE_MAX;
  }
  if (origin === "https://api.anthropic.com" && protocolId === "anthropic") {
    const minor = /^claude-(?:opus|sonnet|haiku)-4-(\d+)(?:-|$)/.exec(model)?.[1];
    if ((minor !== undefined && Number(minor) >= 7) || /^claude-mythos(?:-|$)/.test(model)) {
      return "omit";
    }
    return CLAUDE_TEMPERATURE_MAX;
  }
  if (origin === "https://generativelanguage.googleapis.com" && protocolId === "gemini") {
    const name = model.replace(/^models\//, "");
    if (/^gemini-(?:3\.5-flash-lite|3\.6-flash|3\.8-flash)(?:-|$)/.test(name)) return "omit";
    return STANDARD_TEMPERATURE_MAX;
  }
  if (origin === "https://api.deepseek.com" && (isOpenAiFormat || protocolId === "anthropic")) {
    // This is the accepted range. Thinking mode can ignore the setting.
    return STANDARD_TEMPERATURE_MAX;
  }
  return "unknown";
}

export function combineTemperatureLimits(
  limits: Iterable<ModelTemperatureLimit>,
): TemperaturePolicy {
  let maximum: number | null = null;
  let requiresOmission = false;
  let hasUnknownLimit = false;
  for (const limit of limits) {
    if (limit === "omit") requiresOmission = true;
    else if (limit === "unknown") hasUnknownLimit = true;
    else maximum = maximum === null ? limit : Math.min(maximum, limit);
  }
  return { maximum, requiresOmission, hasUnknownLimit };
}

/** Keep a stored number editable without rounding or exposing exponential notation. */
export function formatTemperature(value: number | null): string {
  if (value === null) return "";
  const [decimal, exponent] = String(value).split("e");
  if (exponent === undefined) return decimal!;
  const [whole, fractional = ""] = decimal!.split(".");
  const digits = whole + fractional;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}
