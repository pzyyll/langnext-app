export const MAX_TEMPERATURE = 2;
const TEMPERATURE_TENTHS = 10;
const MAX_TEMPERATURE_TENTHS = MAX_TEMPERATURE * TEMPERATURE_TENTHS;

/** Blank is optional; a trailing dot is allowed while editing. */
export function isTemperatureText(value: string): boolean {
  return /^(?:[01](?:\.[0-9]?)?|2(?:\.0?)?)?$/.test(value);
}

export function isTemperature(value: number): boolean {
  const tenths = value * TEMPERATURE_TENTHS;
  return Number.isInteger(tenths) && tenths >= 0 && tenths <= MAX_TEMPERATURE_TENTHS;
}

export function formatTemperature(value: number | null): string {
  return value === null ? "" : value.toFixed(1);
}

export function stepTemperature(value: string, direction: -1 | 1): string {
  const current = value === "" ? -1 : Math.round(Number(value) * TEMPERATURE_TENTHS);
  const next = Math.min(MAX_TEMPERATURE_TENTHS, Math.max(0, current + direction));
  return formatTemperature(next / TEMPERATURE_TENTHS);
}
