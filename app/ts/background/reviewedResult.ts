import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { encodeBigIntOrBytesForJson } from '../utils/bigint.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { isRecord } from '../utils/runtimeTypeGuards.js'
import { getSendAnywayOverrideReason, isRejectOnlyTransaction } from '../utils/sendAnywayConsent.js'

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
	safeFlow: true,
	safeMessageCoSignSnapshot: true,
	// Identity and signer round-trip bookkeeping, which change without changing what the user reviewed.
	type: false,
	uniqueRequestIdentifier: false,
	popupOrTabId: false,
	approvalStatus: false,
	// Bind the visualization and its signing inputs together, including the simulated signer and Safe message review.
	signedMessageTransaction: true,
	// A wallet_sendCalls batch: the calls prepared from the request, the website, account and network it is approved for, how its website is shown, and whether its calls run as Gnosis Safe executions are all shown or simulated for review.
	transactionsToSimulate: true,
	binding: true,
	websiteDisplay: true,
	executeCallsThroughSafe: true,
	// The simulation input the batch preview ran on. Approval commits only against that input, so an accept is bound to it like to the preview itself.
	simulatedInputFingerprint: true,
	// The id returned to the website. It is fixed when the batch is admitted and is identity, like uniqueRequestIdentifier, rather than reviewed content.
	batchId: false,
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

// An accept authorizes only the stored request whose reviewed content the user saw. A transaction or batch without a reviewable result cannot be accepted at all, and a failing or quarantined result also needs the send-anyway override.
export function isAcceptForStoredResult(pending: PendingTransactionOrSignableMessage, accept: { readonly reviewedResultId: string, readonly forceSend: boolean }) {
	if (getReviewedResultId(pending) !== accept.reviewedResultId) return false
	if (isRejectOnlyTransaction(pending)) return false
	return accept.forceSend || getSendAnywayOverrideReason(pending) === undefined
}
