import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { dataStringWith0xStart } from './bigint.js'
import { keccak256, stringToBytes } from './ethereumPrimitives.js'
import { isRecord } from './runtimeTypeGuards.js'

type FieldOf<T> = T extends unknown ? keyof T : never
type PendingRequestField = FieldOf<PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage>

// Whether the user reviews each pending-request field in the popup. Typing this as a Record over every field makes a newly added field fail to compile until it is classified here.
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
	// Identity and signer round-trip bookkeeping, which change without changing what the user reviewed.
	type: false,
	uniqueRequestIdentifier: false,
	popupOrTabId: false,
	approvalStatus: false,
	// Never sent to the popup, which reviews the visualizedPersonalSignRequest built from it instead.
	signedMessageTransaction: false,
}

const isReviewedField = (field: string) => Object.entries(IS_REVIEWED_FIELD).some(([reviewedField, isReviewed]) => isReviewed && reviewedField === field)

// Sorts object keys so the id does not depend on field order, which can differ between the stored request and the copy the popup parsed.
const stringifyCanonically = (value: unknown) => JSON.stringify(value, (_key, nested: unknown) => {
	if (typeof nested === 'bigint') return `0x${ nested.toString(16) }`
	if (nested instanceof Uint8Array) return dataStringWith0xStart(nested)
	if (isRecord(nested)) return Object.fromEntries(Object.entries(nested).sort(([first], [second]) => first < second ? -1 : 1))
	return nested
})

// Identifies what the user reviewed for a pending request. The popup sends the id of the request it showed with an accept, and the background honours the accept only while the stored request still has that id, so approval-status changes keep it while a changed result, request or signer does not.
export const getReviewedResultId = (pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage) => {
	const reviewedContent = Object.fromEntries(Object.entries(pending).filter(([field]) => isReviewedField(field)))
	return keccak256(stringToBytes(stringifyCanonically(reviewedContent)))
}
