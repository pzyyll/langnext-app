# Edge TTS Guest Fixtures

Request and error-response shapes for the `speech.synthesize@1` guest. These capture the
OpenAI-compatible contract the guest builds and the error bodies the host maps to stable
`plugin-error` variants.

- `synthesize-request.json` - request body the guest POSTs to `v1/audio/speech`. `pitch` is a
  string scalar (`-50`..`50`); `f64::to_string` strips trailing zeros.
- `error-response-400.json` - OpenAI-shaped 400 body; status maps to `invalid-request`.
- `error-response-429.json` - OpenAI-shaped 429 body; status maps to `rate-limited`.

Success responses are binary MP3 carried by a host-owned `blob-handle`; no JSON fixture is
needed. Conformance host wiring consumes these fixtures once the Edge TTS runtime adapter lands.
