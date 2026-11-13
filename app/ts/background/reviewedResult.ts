import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { encodeBigIntOrBytesForJson } from '../utils/bigint.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { isRecord } from '../utils/runtimeTypeGuards.js'

type FieldOf<T> = T extends unknown ? keyof T : never
type PendingRequestField = FieldOf<PendingTransactionOrSignableMessage>

// Whether the user reviews each stored pending-request field through the popup. Typing this as a Record over every field makes a newly added field fail to compile until it is classified here.
const IS_REVIEWED_FIELD: Record<PendingRequestField, boolean> = {
	// What the request asks to sign or send, and the simulation, signature and Safe details the popup shows for it.
	originalRequestParameters: true,
	transactionOrMessageCreationStatus: true,
	transactionIdentifier: true,
	transactionToSimulate: true,
	popupVisualisation: true,
	visualizedPersonalSignRequest: true,
	activeAddress: true,
	simulationMode: true,
	website: true,
	created: true,
	safeTransaction: true,
	safeExecutionSignerAddress: true,
	safeExecutionOriginalRequestParameters: true,
	safeExecutionReviewedSafeState: true,
	safeMessageCoSignSnapshot: true,
	// Whether a simulation-mode transaction runs as the Gnosis Safe executing it, which decides the simulated result and who the popup shows paying for gas.
	executeThroughSafe: true,
	// Identity and signer round-trip bookkeeping, which change without changing what the user reviewed.
	type: false,
	uniqueRequestIdentifier: false,
	popupOrTabId: false,
	approvalStatus: false,
	// The popup reviews the visualizedPersonalSignRequest built from it instead.
	signedMessageTransaction: false,
}

const isReviewedField = (field: string) => Object.entries(IS_REVIEWED_FIELD).some(([reviewedField, isReviewed]) => isReviewed && reviewedField === field)

// Sorts object keys so the id does not depend on the order fields were written in.
export const stringifyCanonically = (value: unknown) => JSON.stringify(value, (_key, nested: unknown) => {
	const encoded = encodeBigIntOrBytesForJson(nested)
	return isRecord(encoded) ? Object.fromEntries(Object.entries(encoded).sort(([first], [second]) => first < second ? -1 : 1)) : encoded
})

// Identifies what the user reviews for a stored pending request. The background stamps each popup copy with it, the popup returns it unchanged with an accept, and the background honours the accept only while the stored request still has that id, so approval-status changes keep it while a changed result, request or signer does not. It answers whether an accept is for exactly the result on screen, so any shown change invalidates it, per-block re-simulations included, and an accept that races one is refused and needs a re-click on the refreshed result.
export const getReviewedResultId = (pending: PendingTransactionOrSignableMessage) => {
	const reviewedContent = Object.fromEntries(Object.entries(pending).filter(([field]) => isReviewedField(field)))
	return keccak256(stringToBytes(stringifyCanonically(reviewedContent)))
}
