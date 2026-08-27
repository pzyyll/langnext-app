# Implementation Plan

**Goal:** Replace three duplicated same-digest concurrency setups with one descriptive Rust test helper while preserving the single-flight timing, results, and retry assertions.

**Inputs:** The supplied concurrency-fixture analysis; `src-tauri/src/services/default_package_activation/tests/mod.rs`; `DefaultPackageActivationService::verify_shared_package_snapshot`; `VerifiedActivationSnapshot`; existing single-flight tests and constants.

**Assumptions:**

- The helper covers only `default_package_activation_single_flight_same_digest`, `default_package_activation_single_flight_verification_failure`, and `default_package_activation_single_flight_verification_panic`.
- `default_package_activation_single_flight_waiter_cancellation` keeps its dedicated three-party caller coordination and cancellation token.
- The user declined the seam confirmation prompt. The seam below is therefore a plan assumption.

**Architecture:** Keep the helper in the existing test module near `wait_for_same_generation_overlap`. It will install the two-party worker hold, start two same-digest callers together, wait until the genuine worker and both callers overlap, release the worker, clear the test hook, join both threads, and return both unmodified results. Each test will keep its domain-specific success, normalized failure, panic, call-count, cleanup, and retry assertions.

**Tech Stack:** Rust 2024, `std::sync::Barrier`, `std::thread`, Cargo test through mise.

---

## Requirement Map

| Finding or requirement                                                              | Plan coverage                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Three tests duplicate barriers, clones, threads, overlap wait, release, and cleanup | Task 1 extracts exactly that sequence.                                                                                   |
| Worker barrier must remain two-party                                                | Helper uses `SINGLE_FLIGHT_WORKER_HOLD_PARTIES`.                                                                         |
| Caller barrier must remain two-party                                                | Helper uses `SAME_DIGEST_CONCURRENT_CALLERS`.                                                                            |
| Wait for worker start and joined callers before release                             | Helper calls `wait_for_same_generation_overlap` before `block.wait()`.                                                   |
| Release and clear hook before joining                                               | Helper preserves this order.                                                                                             |
| Do not swallow errors or panics                                                     | Helper returns both `Result<Arc<VerifiedActivationSnapshot>, StorageError>` values and keeps thread join panics visible. |
| Failure/panic tests retain normalized assertions                                    | Assertions remain in each test.                                                                                          |
| Cancellation test must not reuse helper                                             | Explicitly excluded and guarded by final diff review.                                                                    |
| Targeted and full validation                                                        | Task 1 and Final Validation include all single-flight tests and the full Rust suite.                                     |

## File Map

- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs` — add `run_same_digest_overlap` and replace the three duplicated setup blocks.
- Test: `src-tauri/src/services/default_package_activation/tests/mod.rs` — existing public-behavior tests remain the validation seam; no new production test hook or module is created.

No production file changes. No new code file is required, so the repository `ABOUTME:` header remains unchanged.

## Seams

- **Seam:** `DefaultPackageActivationService::verify_shared_package_snapshot` as exercised by the existing single-flight tests — verifies one genuine verification for two overlapping same-digest callers, identical normalized failures, normalized panic publication, flight cleanup, and retry behavior.

## Tasks

### Task 1: Extract the same-digest overlap fixture

**Seam:** `DefaultPackageActivationService::verify_shared_package_snapshot` as exercised by the existing single-flight tests.

**Outcome:** One helper owns the repeated concurrency choreography, while all three tests preserve their existing observable assertions and the cancellation test remains specialized.

**Files:**

- Modify: `src-tauri/src/services/default_package_activation/tests/mod.rs`
- Test: `src-tauri/src/services/default_package_activation/tests/mod.rs`

**Steps:**

- [ ] Run the three existing test filters before editing and record that they pass. This is the behavior baseline for the refactor.
- [ ] **Red:** Replace only the setup block in `default_package_activation_single_flight_same_digest` with a call to the not-yet-defined `run_same_digest_overlap(&activation, &digest)`. Keep its result and retry assertions unchanged.
- [ ] Run the focused test and confirm compilation fails because `run_same_digest_overlap` is undefined. This compile-red proves the test now depends on the planned seam adapter before implementation.
- [ ] **Green:** Add this exact helper signature near `wait_for_same_generation_overlap`:

  ```rust
  fn run_same_digest_overlap(
    activation: &DefaultPackageActivationService,
    digest: &str,
  ) -> (
    Result<Arc<VerifiedActivationSnapshot>, StorageError>,
    Result<Arc<VerifiedActivationSnapshot>, StorageError>,
  )
  ```

- [ ] **Green:** Use the existing named constants. Do not replace party counts or timeout values with literals.
- [ ] **Green:** Install `verification_block` with `Barrier::new(SINGLE_FLIGHT_WORKER_HOLD_PARTIES)`.
- [ ] **Green:** Start two cloned services and owned digest strings behind `Barrier::new(SAME_DIGEST_CONCURRENT_CALLERS)`.
- [ ] **Green:** Call `wait_for_same_generation_overlap(activation, SAME_DIGEST_CONCURRENT_CALLERS)` before releasing the worker barrier.
- [ ] **Green:** Preserve the cleanup order exactly: release with `block.wait()`; set `verification_block` to `None`; then join the first and second caller threads.
- [ ] **Green:** Join with descriptive `expect` messages so a caller-thread panic still fails the test. Return each verification `Result` unchanged. Do not call `expect`, `unwrap_err`, normalize, compare, or count verifications inside the helper.
- [ ] Run the success test and confirm it passes with its existing snapshot, one-call, cleanup, and retry assertions.
- [ ] Replace only the duplicated setup in `default_package_activation_single_flight_verification_failure`. Keep both `expect_err`, error type/string equality, call-count, authorization, and retry assertions in the test. Run this test immediately.
- [ ] Replace only the duplicated setup in `default_package_activation_single_flight_verification_panic`. Keep panic-message normalization, poisoned-lock handling, call-count, and retry assertions in the test. Run this test immediately.
- [ ] Remove now-unused function-local `StdArc`, `Barrier`, and `thread` imports from the three migrated tests. Add the minimum module/helper-local imports in repository style.
- [ ] Inspect `default_package_activation_single_flight_waiter_cancellation` and confirm its block, three-party start barrier, cancellation token, and thread sequencing are unchanged.
- [ ] Do not alter `wait_for_same_generation_overlap`, `FlightJoinObservation`, production single-flight code, timeouts, or test-only service hooks.

**Validation:**

- Run (baseline): `mise run test default_package_activation_single_flight_same_digest && mise run test default_package_activation_single_flight_verification_failure && mise run test default_package_activation_single_flight_verification_panic`
- Expected: All three tests pass before the refactor.
- Run (red): `mise run test default_package_activation_single_flight_same_digest`
- Expected: Rust compilation fails with `cannot find function run_same_digest_overlap in this scope`.
- Run (green, success): `mise run test default_package_activation_single_flight_same_digest`
- Expected: The test passes; overlapping callers share one verification and a later retry starts a second flight.
- Run (green, failure): `mise run test default_package_activation_single_flight_verification_failure`
- Expected: The test passes; both callers receive equal validation errors, one verification runs, and the authorized retry succeeds.
- Run (green, panic): `mise run test default_package_activation_single_flight_verification_panic`
- Expected: The test passes; both callers receive the same normalized panic result, one failed verification runs, and a later flight succeeds.

## Final Validation

Run in order:

1. `mise run test default_package_activation_single_flight`
   - Expected: Every single-flight test passes, including different-digest, cleanup, failure, panic, and waiter cancellation cases.
2. `mise run test default_package_activation_single_flight_waiter_cancellation`
   - Expected: The specialized cancellation test passes and reports at least one executed test.
3. `cargo check --manifest-path src-tauri/Cargo.toml --locked`
   - Expected: Rust check succeeds without changing `src-tauri/Cargo.lock`.
4. `mise run test`
   - Expected: The complete Rust test suite passes.
5. `mise run format:check`
   - Expected: rustfmt and oxfmt report no change.
6. `mise run lint`
   - Expected: Repository lint passes; no frontend code was changed.

Review the final diff:

- Expected: only `src-tauri/src/services/default_package_activation/tests/mod.rs` changed.
- Expected: the repeated setup appears once in `run_same_digest_overlap`.
- Expected: the cancellation test's special coordination is unchanged.
- Expected: no assertion moved into the helper.

## Failure Behavior

- Overlap never forms — existing bounded wait panics after `SINGLE_FLIGHT_TEST_TIMEOUT`; the helper must not add an unbounded wait.
- Caller thread panics — helper join fails the test with the caller-specific message.
- Verification returns an error — helper returns it unchanged for the test to assert.
- Test hook lock is poisoned — preserve the existing production/test policy where currently used; do not broaden poison recovery as part of this refactor.

## Privacy and Security

- The helper handles test digests and in-memory synchronization only.
- Do not log package bytes, keys, or other fixture secrets.
- No production trust, verification, cancellation, or authorization behavior changes.

## Rollout Notes

- This is a test-only refactor. It needs no migration or runtime rollout.
- Keep it in a separate change slice from dependency and frontend bundle work so concurrency failures remain attributable.

## Risks and Mitigations

- **Helper hides critical timing** — use the descriptive name and keep the full barrier/wait/release order in one short function beside the observation helper.
- **Cleanup order changes** — assert the order in code review and rerun all single-flight tests.
- **Failure semantics become generic assertions** — return raw results and retain assertions in each caller test.
- **Cancellation setup is forced into a two-caller helper** — leave that test untouched and verify it explicitly in the final diff.

## Open Questions

**Open Questions:** None.
