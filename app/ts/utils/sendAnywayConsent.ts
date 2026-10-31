import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { DecodedError } from '../types/error.js'
import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import { isPossibleToSignMessage } from './personalSignRequest.js'
import { type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from './requests.js'
import { getVisualizedTransactionResult } from './visualizedTransactionResult.js'

export type SendAnywayOverrideReason = 'failingTransaction' | 'quarantinedTransaction' | 'quarantinedSignature'

// The fields the send-anyway rules read. Stored requests (background) and their popup copies (popup) both have this shape, so each side applies the same rules to its own representation.
type SendAnywayConsentInput =
	| { readonly type: 'Transaction', readonly transactionOrMessageCreationStatus: 'Simulated', readonly transactionIdentifier: bigint, readonly popupVisualisation: ConfirmTransactionTransactionSingleVisualization }
	| { readonly type: 'Transaction', readonly transactionOrMessageCreationStatus: 'Crafting' | 'Simulating' | 'FailedToSimulate' }
	| { readonly type: 'SignableMessage', readonly transactionOrMessageCreationStatus: 'Simulated', readonly visualizedPersonalSignRequest: VisualizedPersonalSignRequest }
	| { readonly type: 'SignableMessage', readonly transactionOrMessageCreationStatus: 'Crafting' | 'Simulating' }

type SendAnywayConsent = {
	readonly reason: SendAnywayOverrideReason
	readonly failure: DecodedError | undefined
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
		return { reason: 'quarantinedSignature', failure: undefined, quarantineReasons: signRequest.quarantineReasons }
	}
	const result = getVisualizedTransactionResult(pending.popupVisualisation, pending.transactionIdentifier)
	if (result === undefined) return undefined
	const quarantineReasons = 'quarantineReasons' in result ? result.quarantineReasons : []
	if (result.transactionStatus !== 'Transaction Succeeded') return { reason: 'failingTransaction', failure: getFailureFields(result.error), quarantineReasons }
	return result.quarantine ? { reason: 'quarantinedTransaction', failure: undefined, quarantineReasons } : undefined
}

// Decides when the popup shows the send-anyway checkbox and keeps confirm disabled until it is ticked. The background uses the same rule to refuse accepts that lack the override.
export const getSendAnywayOverrideReason = (pending: SendAnywayConsentInput): SendAnywayOverrideReason | undefined => getSendAnywayConsent(pending)?.reason

// A transaction whose simulation failed or has no located result gives the user no result to review, so the popup offers only rejection and the background refuses accepts even with the send-anyway override.
export const isRejectOnlyTransaction = (pending: SendAnywayConsentInput) => {
	return pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' && getVisualizedTransactionResult(pending.popupVisualisation, pending.transactionIdentifier) === undefined
}

// Stays the same across re-simulations that only change per-block details, so a ticked override survives them but not a new failure or quarantine reason.
export const getSendAnywayConsentFingerprint = (pending: SendAnywayConsentInput) => {
	const consent = getSendAnywayConsent(pending)
	return consent === undefined ? undefined : JSON.stringify(consent)
}

// The send-anyway override covers one request and the failure or quarantine reasons the user acknowledged for it.
export const isSameSendAnywayConsent = (first: SendAnywayConsentInput & { readonly uniqueRequestIdentifier: UniqueRequestIdentifier }, second: SendAnywayConsentInput & { readonly uniqueRequestIdentifier: UniqueRequestIdentifier }) => {
	return doesUniqueRequestIdentifiersMatch(first.uniqueRequestIdentifier, second.uniqueRequestIdentifier) && getSendAnywayConsentFingerprint(first) === getSendAnywayConsentFingerprint(second)
}
