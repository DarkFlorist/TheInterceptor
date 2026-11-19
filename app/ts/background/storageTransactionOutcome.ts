// Shared commit/rollback phases for storage transactions consumed by configuration workflows.
export type StorageTransactionOutcome =
	| { readonly status: 'completed', readonly storage: 'written' }
	| { readonly status: 'failed', readonly storage: 'not-written' | 'rolled-back' | 'rollback-failed', readonly error: unknown }
