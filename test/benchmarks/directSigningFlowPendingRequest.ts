import { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { DirectSigningRecord } from '../../app/ts/types/directSigning.js'
import { SigningWalletBinding } from '../../app/ts/types/signingWallet.js'
import { keccak256 } from '../../app/ts/utils/ethereumBytes.js'

// The website request a direct-signing walkthrough starts from: reviewed in signing mode, with a successful simulated result for a transaction so its approval is enabled.
export function createDirectSigningFlowPendingRequest(record: DirectSigningRecord) {
	const { method, data } = record.input
	const address = record.input.address
	const uniqueRequestIdentifier = { requestId: record.request.requestId, requestSocket: { tabId: record.request.requestSocket.tabId, connectionName: `0x${ record.request.requestSocket.connectionName.toString(16) }` } }
	const originalRequestParameters = method === 'eth_sendTransaction' ? { method, params: [{ from: address, to: address, value: '0x0' }] } : method === 'personal_sign' ? { method, params: [data, address] } : { method, params: [address, data] }
	const website = { websiteOrigin: record.websiteOrigin }
	const created = '0x1'
	const common = { popupOrTabId: { type: 'tab', id: record.request.requestSocket.tabId }, originalRequestParameters, uniqueRequestIdentifier, simulationMode: false, activeAddress: address, created, website, approvalStatus: { status: 'WaitingForUser' }, transactionOrMessageCreationStatus: 'Simulated', signingWalletBinding: SigningWalletBinding.serialize(record.binding), signingChainId: '0x1' }
	const addressEntry = { type: 'contact', address, name: 'Public test account', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true }
	const rpcNetwork = { name: 'Local fixture', chainId: '0x1', httpsRpc: record.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	if (method === 'eth_sendTransaction') {
		const transaction = { type: '0x2', from: address, to: address, chainId: '0x1', nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', value: '0x38d7ea4c68000', input: '0x', accessList: [] }
		const transactionToSimulate = { website, created, originalRequestParameters, transactionIdentifier: '0x1', success: true, transaction }
		const simulatedTransaction = { website, created, parsedInputData: { type: 'NonParsed', input: '0x' }, transactionIdentifier: '0x1', originalRequestParameters, tokenBalancesAfter: [], tokenPriceEstimates: [], gasSpent: '0x5208', realizedGasPrice: '0x3b9aca00', quarantine: false, quarantineReasons: [], events: [], transaction: { ...transaction, type: '1559', from: addressEntry, to: addressEntry, rpcNetwork, hash: keccak256(data) }, transactionStatus: 'Transaction Succeeded' }
		const popupVisualisation = { statusCode: 'success', data: {
			activeAddress: address, simulationMode: false, simulationStartedTimestamp: created, uniqueRequestIdentifier, transactionToSimulate, signerName: 'NoSignerDetected', confirmationRunId: { lifetime: 'walkthrough', sequence: 1 },
			addressBookEntries: [addressEntry], tokenPriceEstimates: [], namedTokenIds: [],
			simulationState: { success: true, simulationStateInput: [], simulatedBlocks: [], blockNumber: '0x1', blockTimestamp: created, baseFeePerGas: '0x1', simulationConductedTimestamp: created, rpcNetwork },
			visualizedSimulationState: { success: true, visualizedBlocks: [{ simulatedAndVisualizedTransactions: [simulatedTransaction], visualizedPersonalSignRequests: [], blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0x0', deltaUnit: 'Seconds' } }] },
		} }
		return PendingTransactionOrSignableMessage.parse({ ...common, type: 'Transaction', transactionIdentifier: '0x1', transactionToSimulate, popupVisualisation, safeFlow: { kind: 'ordinary' } })
	}
	const visualizedPersonalSignRequest = { activeAddress: addressEntry, account: addressEntry, rpcNetwork, simulationMode: false, signerName: 'NoSignerDetected', quarantineReasons: [], quarantine: false, website, created, rawMessage: data, stringifiedMessage: data, messageIdentifier: '0x1', method, type: 'NotParsed', message: data }
	return PendingTransactionOrSignableMessage.parse({ ...common, type: 'SignableMessage', visualizedPersonalSignRequest, signedMessageTransaction: { website, created, fakeSignedFor: address, activeAddress: address, originalRequestParameters, request: { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, ...originalRequestParameters }, simulationMode: false, messageIdentifier: '0x1' } })
}
