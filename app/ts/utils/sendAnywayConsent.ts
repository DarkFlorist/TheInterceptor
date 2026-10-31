import type { ConfirmTransactionTransactionSingleVisualization, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import type { MaybeSimulatedTransaction, VisualizedSimulationState } from '../types/visualizer-types.js'
import type { DecodedError } from '../types/error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS } from './constants.js'
import { doesUniqueRequestIdentifiersMatch } from './requests.js'

export type SendAnywayOverrideReason = 'failingTransaction' | 'quarantinedTransaction' | 'quarantinedSignature'

export const getResultsForTransaction = (visualizedSimulationState: VisualizedSimulationState, transactionIdentifier: bigint) => {
	return visualizedSimulationState.visualizedBlocks
		.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)
}

// The simulated result the popup shows for a transaction, or undefined when the simulation failed or produced no result for it, in which case the popup offers only rejection.
export const getVisualizedTransactionResult = (popupVisualisation: ConfirmTransactionTransactionSingleVisualization, transactionIdentifier: bigint) => {
	if (popupVisualisation.statusCode !== 'success' || popupVisualisation.data.visualizedSimulationState.success === false) return undefined
	return getResultsForTransaction(popupVisualisation.data.visualizedSimulationState, transactionIdentifier)
}

export function isPossibleToSignMessage(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
	return !(visualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || visualizedPersonalSignRequest.method !== 'personal_sign'))
}

type SendAnywayConsent = {
	readonly reason: SendAnywayOverrideReason
	readonly failure: DecodedError | undefined
	readonly quarantineReasons: readonly string[]
}

// The popup shows the decoded reason and revert data, and two different reverts can share the raw message, so all error fields count.
const getFailureFields = (error: DecodedError): DecodedError => ({ code: error.code, message: error.message, decodedErrorMessage: error.decodedErrorMessage, data: error.data })

// What the user acknowledges by ticking send-anyway: why the override is needed, the failure and the quarantine reasons. Fees, timestamps, balances and other per-block churn are left out, including the insufficient-balance wording the popup derives from balances for the same failure.
function getSendAnywayConsent(pending: PopupPendingTransactionOrSignableMessage): SendAnywayConsent | undefined {
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

// Decides when the popup shows the send-anyway checkbox. requiresSendAnywayOverride builds on it for the confirm gate shared by the popup and the background.
export const getSendAnywayOverrideReason = (pending: PopupPendingTransactionOrSignableMessage): SendAnywayOverrideReason | undefined => getSendAnywayConsent(pending)?.reason

// Whether confirming needs the send-anyway override: the popup keeps confirm disabled until it is ticked, and the background refuses accepts without it. A transaction whose simulation failed or has no located result counts too, since the user had no result to review; the popup shows no checkbox there and offers only rejection, so such an override can only come from a caller other than the popup.
export const requiresSendAnywayOverride = (pending: PopupPendingTransactionOrSignableMessage) => {
	if (getSendAnywayOverrideReason(pending) !== undefined) return true
	return pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' && getVisualizedTransactionResult(pending.popupVisualisation, pending.transactionIdentifier) === undefined
}

// Stays the same across re-simulations that only change per-block details, so a ticked override survives them but not a new failure or quarantine reason.
export const getSendAnywayConsentFingerprint = (pending: PopupPendingTransactionOrSignableMessage) => {
	const consent = getSendAnywayConsent(pending)
	return consent === undefined ? undefined : JSON.stringify(consent)
}

// Requests stored before revisions existed start at zero.
export const getResultRevision = (pending: Pick<PopupPendingTransactionOrSignableMessage, 'resultRevision'>) => pending.resultRevision ?? 0

// The send-anyway override covers one request and the failure or quarantine reasons the user acknowledged for it.
export const isSameSendAnywayConsent = (first: PopupPendingTransactionOrSignableMessage, second: PopupPendingTransactionOrSignableMessage) => {
	return doesUniqueRequestIdentifiersMatch(first.uniqueRequestIdentifier, second.uniqueRequestIdentifier) && getSendAnywayConsentFingerprint(first) === getSendAnywayConsentFingerprint(second)
}
