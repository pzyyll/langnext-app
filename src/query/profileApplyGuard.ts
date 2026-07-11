// ABOUTME: Guards out-of-order profile apply responses on the translate page.
// ABOUTME: A newer selection must not be overwritten by a slower earlier fetch.
/**
 * True when the response for `requestGeneration` still matches the latest
 * user selection generation.
 */
export function shouldApplyProfileResult(requestGeneration: number, latestGeneration: number): boolean {
	return requestGeneration === latestGeneration;
}
