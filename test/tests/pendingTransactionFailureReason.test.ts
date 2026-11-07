import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { encodeErrorString } from './errorDataFixtures.js'
import { addMissingTransactionCreationFailureReason } from '../../app/ts/components/pages/pendingTransactionFailureReason.js'
import { TransactionCreationError } from '../../app/ts/types/error.js'

const activeAddress = 0x1111111111111111111111111111111111111111n
const created = new Date('2024-01-01T00:00:00.000Z')
const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
// Spelled out rather than imported: this is the text already in users' storage, which the Safe layer's current wording must not affect.
const storedLegacySafeCallRevertedMessage = 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'
const originalRequestParameters = { method: 'eth_sendTransaction' as const, params: [{ from: activeAddress, to: 0x2222222222222222222222222222222222222222n, value: 0n, input: new Uint8Array() }] as const }

const createFailedToSimulatePendingTransaction = (error: TransactionCreationError, transactionCreationFailureReason: string | undefined) => {
	const transactionToSimulate = { website, created, originalRequestParameters, transactionIdentifier: 1n, success: false as const, error }
	return {
		type: 'Transaction' as const,
		transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
		popupOrTabId: { type: 'popup' as const, id: 1 },
		originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier: 1n,
		transactionToSimulate,
		website,
		approvalStatus: { status: 'WaitingForUser' as const },
		popupVisualisation: {
			statusCode: 'failed' as const,
			data: {
				activeAddress,
				simulationMode: true,
				simulationStartedTimestamp: created,
				uniqueRequestIdentifier,
				transactionToSimulate,
				...(transactionCreationFailureReason === undefined ? {} : { transactionCreationFailureReason }),
				signerName: 'NoSignerDetected' as const,
				error: { code: -32000, message: 'eth_simulateV1 rejected the stack', decodedErrorMessage: 'eth_simulateV1 rejected the stack' },
				simulationState: { blockNumber: 123n, simulationConductedTimestamp: created },
			},
		},
	}
}

const getFailureReason = (error: TransactionCreationError, transactionCreationFailureReason: string | undefined) => {
	const pending = addMissingTransactionCreationFailureReason(createFailedToSimulatePendingTransaction(error, transactionCreationFailureReason))
	if (pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') throw new Error('Expected a transaction that failed to be created')
	return pending.popupVisualisation.data.transactionCreationFailureReason
}

describe('addMissingTransactionCreationFailureReason', () => {
	test('derives the reason of failed transactions stored by older versions without ABIs', () => {
		assert.equal(getFailureReason({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, undefined), 'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		assert.equal(getFailureReason({ code: -32000, message: 'execution reverted', data: '0x01020304' }, undefined), 'execution reverted')
	})

	test('keeps the insufficient balance explanation, with its amounts, that older versions stored as the message even when the revert data has a reason', () => {
		const legacyInsufficientBalanceMessage = 'Insufficient ETH balance. Available: 1 ETH. Attempting to send: 2 ETH.'
		assert.equal(getFailureReason({ code: -32000, message: legacyInsufficientBalanceMessage, data: '0x' }, undefined), legacyInsufficientBalanceMessage)
		assert.equal(getFailureReason({ code: -32000, message: legacyInsufficientBalanceMessage, data: encodeErrorString('ERC20: transfer amount exceeds balance') }, undefined), legacyInsufficientBalanceMessage)
	})

	test('keeps the Gnosis Safe\'s GS013 explanation that older versions stored as the message instead of the bare GS013 its revert data decodes to', () => {
		assert.equal(getFailureReason({ code: 3, message: storedLegacySafeCallRevertedMessage, data: encodeErrorString('GS013') }, undefined), storedLegacySafeCallRevertedMessage)
	})

	test('shows the Gnosis Safe\'s explanation from its field in whatever wording the Safe layer wrote, after parsing it as a stored failure', () => {
		const safeCallRevertedMessage = 'A reworded explanation of the Safe\'s GS013.'
		const storedError = TransactionCreationError.parse({ code: 3, message: 'execution reverted: GS013', data: encodeErrorString('GS013'), safeCallRevertedMessage })
		assert.equal(getFailureReason(storedError, undefined), safeCallRevertedMessage)
	})

	test('decodes the revert reason of a message that only resembles the Gnosis Safe\'s older explanation', () => {
		assert.equal(getFailureReason({ code: 3, message: `${ storedLegacySafeCallRevertedMessage } Reworded.`, data: encodeErrorString('GS013') }, undefined), 'GS013')
	})

	test('decodes the revert reason when a contract\'s own message only resembles an Interceptor explanation', () => {
		assert.equal(getFailureReason({ code: -32000, message: 'Insufficient ETH balance', data: encodeErrorString('STF') }, undefined), 'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
	})

	test('never replaces a stored reason', () => {
		const pending = createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') }, 'Reason derived by the background')
		assert.equal(addMissingTransactionCreationFailureReason(pending), pending)
	})

	test('leaves transactions that were created unchanged', () => {
		const failed = createFailedToSimulatePendingTransaction({ code: -32000, message: 'execution reverted', data: '0x' }, undefined)
		const transactionToSimulate = { website, created, originalRequestParameters, transactionIdentifier: 1n, success: true as const, transaction: { type: '1559' as const, from: activeAddress, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21_000n, to: 0x2222222222222222222222222222222222222222n, value: 0n, input: new Uint8Array(), chainId: 1n, accessList: [] } }
		const simulated = { ...failed, transactionOrMessageCreationStatus: 'Simulated' as const, transactionToSimulate, popupVisualisation: { ...failed.popupVisualisation, data: { ...failed.popupVisualisation.data, transactionToSimulate } } }
		assert.equal(addMissingTransactionCreationFailureReason(simulated), simulated)
	})
})
