// ABOUTME: Opaque application-owned credential reference generation.
// ABOUTME: Replacement writes use unique operation UUIDs so vault keys never overwrite.
use uuid::Uuid;

/// Build a Provider credential account name for the OS vault.
pub fn provider_ref(provider_id: Uuid, operation_id: Uuid) -> String {
	format!("provider/{provider_id}/{operation_id}")
}

/// Build the global proxy credential account name for the OS vault.
pub fn global_proxy_ref(operation_id: Uuid) -> String {
	format!("proxy/global/{operation_id}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn refs_include_uuids() {
		let p = Uuid::nil();
		let op = Uuid::from_u128(1);
		assert_eq!(
			provider_ref(p, op),
			"provider/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000001"
		);
		assert!(global_proxy_ref(op).starts_with("proxy/global/"));
	}
}
