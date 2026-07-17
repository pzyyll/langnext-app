// ABOUTME: Local timezone datetime formatting for translation history display.
// ABOUTME: Renders RFC 3339 UTC timestamps as local YYYY-MM-DD HH:mm.

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Format an RFC 3339 UTC timestamp as a local calendar `YYYY-MM-DD HH:mm` string.
 *
 * Uses the `Intl.DateTimeFormat` parts API so the conversion honors the user's
 * local timezone without pulling a date library. Returns the raw input on parse
 * failure so the UI never shows an empty cell.
 */
export function formatHistoryLocalDateTime(rfc3339: string): string {
	const date = new Date(rfc3339);
	if (Number.isNaN(date.getTime())) {
		return rfc3339;
	}
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
}

/** Today's local day as `YYYY-MM-DD`, used as the default for the date filter. */
export function todayLocalDay(): string {
	const date = new Date();
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
