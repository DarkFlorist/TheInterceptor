import type { PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
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
	if (pending.popupVisualisation.statusCode !== 'success' || pending.popupVisualisation.data.visualizedSimulationState.success === false) return undefined
	const result = getResultsForTransaction(pending.popupVisualisation.data.visualizedSimulationState, pending.transactionIdentifier)
	if (result === undefined) return undefined
	const quarantineReasons = 'quarantineReasons' in result ? result.quarantineReasons : []
	if (result.transactionStatus !== 'Transaction Succeeded') return { reason: 'failingTransaction', failure: getFailureFields(result.error), quarantineReasons }
	return result.quarantine ? { reason: 'quarantinedTransaction', failure: undefined, quarantineReasons } : undefined
}

// Decides when the popup shows the send-anyway checkbox. The background uses the same rule to refuse accepts that lack the override.
export const getSendAnywayOverrideReason = (pending: PopupPendingTransactionOrSignableMessage): SendAnywayOverrideReason | undefined => getSendAnywayConsent(pending)?.reason

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
