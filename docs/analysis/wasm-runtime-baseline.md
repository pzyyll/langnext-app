# Wasm Runtime Rollout Baseline

Real measurements for Phase 3 rollout decisions. Regenerate with `mise run plugin:measure-baseline`.

## Environment

- **OS:** MINGW64_NT-10.0-262003.6.9-b4195d69.x86_64x86_64
- **Rust:** rustc 1.96.1 (31fca3adb 2026-06-26)
- **cargo-component:** cargo-component-component 0.21.1
- **Wasmtime:** 47.0.2 (pinned)

## Binary Size

| Artifact    | Size (bytes) |
| ----------- | ------------ |
| Debug lib   | 4990976      |
| Release lib | 3347456      |

## Conformance Fixture

| Property | Value                                                            |
| -------- | ---------------------------------------------------------------- |
| Bytes    | 15793                                                            |
| SHA-256  | ea979f14bbbe04122a176d608a77ad95e49de16daf286930f8461c6b14e587ab |

## Cold-Start

Engine creation, component compilation (cache miss + hit), and first invocation latency:

```
cold-start baseline: engine_create=5.4235ms compile_miss=7.2839ms compile_hit=1.7235ms invoke=1.8849ms total=14.5923ms
```

## Rollout Decision

Compare these values against the prior baseline before approving Phase 3 activation. If debug or
release binary size or cold-start increased materially, review before enabling production plugin
instances. If the release build failed (blocker above), resolve the build error before recording.
