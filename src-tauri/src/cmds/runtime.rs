// ABOUTME: Shared sanitized spawn_blocking helper for storage Tauri commands.
// ABOUTME: Join/panic failures map to a constant internal_error IPC shape.
use crate::error::{IpcError, StorageError};

const INTERNAL_ERROR_CODE: &str = "internal_error";
const INTERNAL_ERROR_MESSAGE: &str = "An internal error occurred";

/// Run a blocking storage closure and map join failures to a constant IPC error.
pub async fn run_blocking<T, F>(command: &'static str, f: F) -> Result<T, IpcError>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, StorageError> + Send + 'static,
{
	match tauri::async_runtime::spawn_blocking(f).await {
		Ok(Ok(value)) => Ok(value),
		Ok(Err(err)) => Err(IpcError::from(err)),
		Err(_join_err) => {
			// Never interpolate join error or panic payload into IPC.
			log::error!("blocking_join_failed command={command}");
			Err(IpcError::new(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE))
		}
	}
}

/// Constant internal IPC error used by join-failure paths (testable without panics).
pub fn join_failure_ipc_error() -> IpcError {
	IpcError::new(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE)
}

/// Helper for tests that want a Future-shaped dispatch without Tauri runtime.
#[cfg(test)]
pub fn map_blocking_result<T>(
	command: &'static str,
	result: Result<Result<T, StorageError>, String>,
) -> Result<T, IpcError> {
	match result {
		Ok(Ok(value)) => Ok(value),
		Ok(Err(err)) => Err(IpcError::from(err)),
		Err(_join_err) => {
			log::error!("blocking_join_failed command={command}");
			Err(join_failure_ipc_error())
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ipc_join_failure_is_constant() {
		let err = join_failure_ipc_error();
		assert_eq!(err.code, "internal_error");
		assert_eq!(err.message, "An internal error occurred");
		assert!(!err.message.contains("panic"));
		assert!(!err.message.contains("poison"));
	}

	#[test]
	fn map_join_error_never_leaks_payload() {
		let result = map_blocking_result(
			"save_provider",
			Err::<Result<(), StorageError>, _>("task panicked: secret-sk-123".into()),
		);
		let err = result.unwrap_err();
		assert_eq!(err.code, "internal_error");
		assert!(!err.message.contains("secret"));
		assert!(!err.message.contains("sk-123"));
	}

	#[test]
	fn map_storage_error() {
		let result: Result<(), IpcError> =
			map_blocking_result("get_settings", Ok(Err(StorageError::Validation("bad theme".into()))));
		let err = result.unwrap_err();
		assert_eq!(err.code, "validation_failed");
		assert_eq!(err.message, "bad theme");
	}
}
