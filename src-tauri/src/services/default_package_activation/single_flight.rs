// ABOUTME: Per-digest single-flight package verification for default activation.
// ABOUTME: Caller-independent workers publish one immutable snapshot per digest generation.
use super::*;

/// Hex characters of the package digest used in the worker thread name.
const PACKAGE_VERIFICATION_THREAD_NAME_DIGEST_PREFIX_LENGTH: usize = 8;
/// How often a cancellable waiter rechecks completion and cancellation while blocked.
const SINGLE_FLIGHT_CANCELLATION_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

impl DefaultPackageActivationService {
  /// Shared per-digest package verification. Concurrent subjects for one digest share one initial
  /// immutable verification; subject grant/CAS remains independent outside this coordinator.
  ///
  /// The first joiner only registers and waits. An independent worker thread owns verification so
  /// cancelling any waiter cannot cancel the worker or strand other waiters.
  pub fn verify_shared_package_snapshot(
    &self,
    package_digest: &str,
  ) -> Result<Arc<VerifiedActivationSnapshot>, StorageError> {
    self.verify_shared_package_snapshot_cancellable(package_digest, None)
  }

  /// Cancellation-aware single-flight entry. When `cancel` becomes true, only this waiter returns
  /// a cancellation error; the shared worker and other waiters continue.
  pub fn verify_shared_package_snapshot_cancellable(
    &self,
    package_digest: &str,
    cancel: Option<&crate::domain::cancel::CancelToken>,
  ) -> Result<Arc<VerifiedActivationSnapshot>, StorageError> {
    let package_digest = package_digest.to_string();
    let (flight, spawned_worker) = {
      let mut flights = self
        .in_flight_verifications
        .lock()
        .map_err(|_| StorageError::Internal("in-flight verification lock poisoned".into()))?;
      if let Some(existing) = flights.get(&package_digest) {
        (existing.clone(), false)
      } else {
        let mut generation_guard = self
          .flight_generation
          .lock()
          .map_err(|_| StorageError::Internal("flight generation lock poisoned".into()))?;
        *generation_guard = generation_guard.saturating_add(1);
        let generation = *generation_guard;
        let flight = Arc::new(InFlightVerification {
          generation,
          completed: Mutex::new(None),
          waiters: Condvar::new(),
        });
        flights.insert(package_digest.clone(), flight.clone());
        (flight, true)
      }
    };

    if spawned_worker {
      // Caller-independent worker: first joiner never runs verification on its own stack.
      let worker_service = self.clone();
      let worker_digest = package_digest.clone();
      let worker_flight = flight.clone();
      std::thread::Builder::new()
        .name(format!(
          "pkg-verify-{}",
          &package_digest[..PACKAGE_VERIFICATION_THREAD_NAME_DIGEST_PREFIX_LENGTH.min(package_digest.len())]
        ))
        .spawn(move || {
          let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            worker_service.verify_policy_bound_package_snapshot(&worker_digest)
          }));
          let published = match result {
            Ok(Ok(snapshot)) => Ok(Arc::new(snapshot)),
            Ok(Err(err)) => Err(err.to_string()),
            Err(_) => Err("package verification panicked".into()),
          };
          // Publish onto the shared Arc, remove the map entry before notifying waiters, then
          // wake them. Waiters already hold the Arc so they still observe completion; new
          // callers must not join a finished flight (they start a fresh generation).
          if let Ok(mut completed) = worker_flight.completed.lock() {
            *completed = Some(published);
          }
          if let Ok(mut flights) = worker_service.in_flight_verifications.lock() {
            if flights
              .get(&worker_digest)
              .is_some_and(|current| current.generation == worker_flight.generation)
            {
              flights.remove(&worker_digest);
            }
          }
          worker_flight.waiters.notify_all();
        })
        .map_err(|e| StorageError::Internal(format!("spawn package verification worker: {e}")))?;
    }

    // Every caller, including the first joiner, waits as a cancellable waiter.
    let mut completed = flight
      .completed
      .lock()
      .map_err(|_| StorageError::Internal("in-flight completion lock poisoned".into()))?;
    loop {
      if let Some(result) = completed.as_ref() {
        return match result {
          Ok(snapshot) => Ok(snapshot.clone()),
          Err(message) => Err(StorageError::Validation(message.clone())),
        };
      }
      if cancel.is_some_and(|token| token.is_cancelled()) {
        return Err(StorageError::Validation("package verification cancelled".into()));
      }
      let (guard, wait_result) = flight
        .waiters
        .wait_timeout(completed, SINGLE_FLIGHT_CANCELLATION_POLL_INTERVAL)
        .map_err(|_| StorageError::Internal("in-flight wait poisoned".into()))?;
      completed = guard;
      // Spurious wake / timeout: loop rechecks completion and cancellation.
      let _ = wait_result;
    }
  }

  /// One policy-bound package verification used only by shared single-flight.
  ///
  /// Exact-checks catalog default, policy digest, installed version, content availability,
  /// current publisher trust, publisher identity, permission digest, verified manifest identity,
  /// public key, and store generation. Never exposes publisher key material in errors.
  pub(super) fn verify_policy_bound_package_snapshot(
    &self,
    package_digest: &str,
  ) -> Result<VerifiedActivationSnapshot, StorageError> {
    #[cfg(test)]
    {
      {
        let mut count = self
          .verification_call_count
          .lock()
          .map_err(|_| StorageError::Internal("verification call counter poisoned".into()))?;
        *count = count.saturating_add(1);
      }
      // Optional test barrier: independent worker blocks here so waiters can cancel mid-flight.
      let block = self
        .verification_block
        .lock()
        .map_err(|_| StorageError::Internal("verification block lock poisoned".into()))?
        .clone();
      if let Some(barrier) = block {
        barrier.wait();
      }
      // One-shot panic injection for single-flight panic publication tests only.
      // Drop every test mutex before panicking so catch_unwind does not poison them.
      let should_panic = {
        let mut panic_once = self
          .verification_panic_once
          .lock()
          .map_err(|_| StorageError::Internal("verification panic flag poisoned".into()))?;
        if *panic_once {
          *panic_once = false;
          true
        } else {
          false
        }
      };
      if should_panic {
        panic!("injected package verification panic");
      }
    }
    let (policy, version, publisher, catalog_default_digest) = self.db.read(|conn| {
      let version = installed_plugin_versions::get(conn, package_digest)?;
      if !version.content_available {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      let catalog_default = installed_plugin_versions::get_default(conn, &version.plugin_id)?
        .ok_or_else(|| StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()))?;
      if catalog_default.package_digest != package_digest {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      let policy = default_package_activation_policies::get_policy(conn, &version.plugin_id)?
        .ok_or_else(|| StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()))?;
      if policy.package_digest != package_digest || policy.package_digest != catalog_default.package_digest {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      let status = default_package_activation_policies::resolve_authorization_status(conn, &version.plugin_id)?;
      if status != DefaultPackageAuthorizationStatus::Authorized {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      let publisher = plugin_publishers::get_optional(conn, &version.publisher_key_id)?
        .ok_or_else(|| StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()))?;
      if publisher.revoked
        || !publisher.enabled
        || publisher.key_id != policy.publisher_key_id
        || publisher.fingerprint != policy.publisher_fingerprint
        || publisher.key_id != version.publisher_key_id
        || publisher.fingerprint != version.publisher_fingerprint
      {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      if policy.permission_request_digest != version.permission_request_digest {
        return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
      }
      Ok((policy, version, publisher, catalog_default.package_digest))
    })?;

    let store_generation = self.packages.store_generation();
    let verified = self.packages.verify_runtime_store_snapshot(
      package_digest,
      &publisher.key_id,
      &publisher.fingerprint,
      &publisher.public_key_hex,
      publisher.source,
    )?;
    if verified.package_digest != package_digest
      || verified.package_digest != catalog_default_digest
      || verified.manifest.id != version.plugin_id
      || verified.manifest.version != version.version
      || verified.manifest.publisher.key_id != policy.publisher_key_id
      || verified.manifest.publisher.key_fingerprint != policy.publisher_fingerprint
      || verified.publisher_fingerprint != policy.publisher_fingerprint
      || verified.publisher_public_key_hex != publisher.public_key_hex
      || compute_permission_request_digest(&verified.manifest) != policy.permission_request_digest
    {
      return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
    }
    Ok(VerifiedActivationSnapshot {
      package_digest: package_digest.to_string(),
      verified,
      policy_constraints_digest: policy.approved_authority_constraints_digest,
      publisher_key_id: publisher.key_id,
      publisher_fingerprint: publisher.fingerprint,
      publisher_public_key_hex: publisher.public_key_hex,
      publisher_source: publisher.source,
      store_generation,
    })
  }
}
