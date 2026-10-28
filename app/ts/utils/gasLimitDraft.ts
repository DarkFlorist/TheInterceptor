// The transaction and gas limit the gas limit field was last set from.
export type GasLimitDraftSource = {
	readonly transactionIdentifier: bigint
	readonly gasLimit: bigint | undefined
}

// What the gas limit field shows once its transaction or gas limit changes. Another transaction starts from its own limit. For the same transaction a new limit, such as a fresh gas estimate after a re-simulation, replaces the draft only while the user has left it at the limit it was set from, so an unsaved edit is kept.
export function getNextGasLimitDraft(draftSource: GasLimitDraftSource, draft: bigint | undefined, next: GasLimitDraftSource) {
	if (draftSource.transactionIdentifier !== next.transactionIdentifier) return next.gasLimit
	if (draft === draftSource.gasLimit) return next.gasLimit
	return draft
}
