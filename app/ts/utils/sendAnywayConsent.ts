import type { ConfirmTransactionBatchVisualization, ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { DecodedError } from '../types/error.js'
import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import { isPossibleToSignMessage } from './personalSignRequest.js'
import { type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from './requests.js'
import { assertNever } from './typescript.js'
import { getTransactionBatchCallResults, getVisualizedTransactionResult } from './visualizedTransactionResult.js'

export type SendAnywayOverrideReason = 'failingTransaction' | 'quarantinedTransaction' | 'quarantinedSignature' | 'failingOrQuarantinedBatchCalls'

// The fields the send-anyway rules read. Stored requests (background) and their popup copies (popup) both have this shape, so each side applies the same rules to its own representation.
type SendAnywayConsentInput =
	| { readonly type: 'Transaction', readonly transactionOrMessageCreationStatus: 'Simulated', readonly transactionIdentifier: bigint, readonly popupVisualisation: ConfirmTransactionTransactionSingleVisualization }
	| { readonly type: 'Transaction', readonly transactionOrMessageCreationStatus: 'Crafting' | 'Simulating' | 'FailedToSimulate' }
	| { readonly type: 'SignableMessage', readonly transactionOrMessageCreationStatus: 'Simulated', readonly visualizedPersonalSignRequest: VisualizedPersonalSignRequest }
	| { readonly type: 'SignableMessage', readonly transactionOrMessageCreationStatus: 'Crafting' | 'Simulating' }
	| { readonly type: 'TransactionBatch', readonly transactionOrMessageCreationStatus: 'Simulated' | 'FailedToSimulate', readonly transactionsToSimulate: readonly { readonly transactionIdentifier: bigint }[], readonly popupVisualisation: ConfirmTransactionBatchVisualization }
	| { readonly type: 'TransactionBatch', readonly transactionOrMessageCreationStatus: 'Crafting' }

type SendAnywayConsent = {
	readonly reason: SendAnywayOverrideReason
	readonly failures: readonly DecodedError[]
	readonly quarantineReasons: readonly string[]
}

// The popup shows the decoded reason and revert data, and two different reverts can share the raw message, so all error fields count.
const getFailureFields = (error: DecodedError): DecodedError => ({ code: error.code, message: error.message, decodedErrorMessage: error.decodedErrorMessage, data: error.data })

// What the user acknowledges by ticking send-anyway: why the override is needed, the failure and the quarantine reasons. Fees, timestamps, balances and other per-block churn are left out, including the insufficient-balance wording the popup derives from balances for the same failure.
function getSendAnywayConsent(pending: SendAnywayConsentInput): SendAnywayConsent | undefined {
	if (pending.transactionOrMessageCreationStatus !== 'Simulated') return undefined
	if (pending.type === 'SignableMessage') {
		const signRequest = pending.visualizedPersonalSignRequest
		if (!isPossibleToSignMessage(signRequest, signRequest.activeAddress.address) || !signRequest.quarantine) return undefined
		return { reason: 'quarantinedSignature', failures: [], quarantineReasons: signRequest.quarantineReasons }
	}
	if (pending.type === 'TransactionBatch') {
		// A batch is approved as a whole, so one acknowledgement covers every call that fails or trips a protector. A call without a result makes the batch reject-only instead (isRejectOnlyTransaction).
		const callResults = getTransactionBatchCallResults(pending).flatMap((callResult) => callResult === undefined ? [] : [callResult])
		const failures = callResults.flatMap((callResult) => callResult.transactionStatus === 'Transaction Succeeded' ? [] : [getFailureFields(callResult.error)])
		const quarantineReasons = callResults.flatMap((callResult) => 'quarantineReasons' in callResult ? callResult.quarantineReasons : [])
		const isQuarantined = callResults.some((callResult) => callResult.transactionStatus === 'Transaction Succeeded' && callResult.quarantine)
		return failures.length === 0 && !isQuarantined ? undefined : { reason: 'failingOrQuarantinedBatchCalls', failures, quarantineReasons }
	}
	const result = getVisualizedTransactionResult(pending.popupVisualisation, pending.transactionIdentifier)
	if (result === undefined) return undefined
	const quarantineReasons = 'quarantineReasons' in result ? result.quarantineReasons : []
	if (result.transactionStatus !== 'Transaction Succeeded') return { reason: 'failingTransaction', failures: [getFailureFields(result.error)], quarantineReasons }
	return result.quarantine ? { reason: 'quarantinedTransaction', failures: [], quarantineReasons } : undefined
}

// Decides when the popup shows the send-anyway checkbox and keeps confirm disabled until it is ticked. The background uses the same rule to refuse accepts that lack the override.
export const getSendAnywayOverrideReason = (pending: SendAnywayConsentInput): SendAnywayOverrideReason | undefined => getSendAnywayConsent(pending)?.reason

// A transaction whose simulation failed or has no located result, or a batch with a call that has none, gives the user no result to review, so the popup offers only rejection and the background refuses accepts even with the send-anyway override.
export const isRejectOnlyTransaction = (pending: SendAnywayConsentInput) => {
	if (pending.transactionOrMessageCreationStatus !== 'Simulated') return false
	switch (pending.type) {
		case 'Transaction': return getVisualizedTransactionResult(pending.popupVisualisation, pending.transactionIdentifier) === undefined
		case 'TransactionBatch': return getTransactionBatchCallResults(pending).some((callResult) => callResult === undefined)
		case 'SignableMessage': return false
		default: return assertNever(pending)
	}
}

// Stays the same across re-simulations that only change per-block details, so a ticked override survives them but not a new failure or quarantine reason. It answers whether the user's send-anyway tick still applies, not whether an accept matches the result on screen, which is what the reviewed-result id answers.
export const getSendAnywayConsentFingerprint = (pending: SendAnywayConsentInput) => {
	const consent = getSendAnywayConsent(pending)
	return consent === undefined ? undefined : JSON.stringify(consent)
}

// The send-anyway override covers one request and the failure or quarantine reasons the user acknowledged for it.
export const isSameSendAnywayConsent = (first: SendAnywayConsentInput & { readonly uniqueRequestIdentifier: UniqueRequestIdentifier }, second: SendAnywayConsentInput & { readonly uniqueRequestIdentifier: UniqueRequestIdentifier }) => {
	return doesUniqueRequestIdentifiersMatch(first.uniqueRequestIdentifier, second.uniqueRequestIdentifier) && getSendAnywayConsentFingerprint(first) === getSendAnywayConsentFingerprint(second)
}
