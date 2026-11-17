// The gas limit supplied by the current transaction or its latest estimate.
type GasLimitDraftSource = {
	readonly transactionIdentifier: bigint
	readonly gasLimit: bigint | undefined
}

export type GasLimitDraft = GasLimitDraftSource & { readonly wasEdited: boolean }

// Edit intent comes from input events, rather than value equality: an estimate can coincidentally match a typed value without saving the user's edit.
export function getNextGasLimitDraft(draft: GasLimitDraft, source: GasLimitDraftSource): GasLimitDraft {
	if (draft.transactionIdentifier !== source.transactionIdentifier || !draft.wasEdited) return { ...source, wasEdited: false }
	return draft
}
