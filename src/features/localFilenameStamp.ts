// ABOUTME: Shared local timestamp helper for default download/export filenames.
// ABOUTME: Format is YYYYMMDDTHHMMSS in the user's local timezone.

/** Local timestamp for default export filenames: YYYYMMDDTHHMMSS. */
export function localFilenameStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
