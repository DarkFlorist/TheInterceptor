import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSimulationStackNameRows, getSimulationStackNameRowsFromResults } from '../../app/ts/components/simulationExplaining/SimulationStackCompactSummary.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createPassthroughCompleteVisualizedSimulation, type BlockTimeManipulationWithNoDelay, type NonSimulatedAndVisualizedTransaction, type PreSimulationTransaction, type SignedMessageTransaction, type SimulationAndVisualisationResults, type SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'

const ACTIVE_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n

const activeAddressEntry: ContactEntry = {
	type: 'contact',
	name: 'Active Address',
	address: ACTIVE_ADDRESS,
	entrySource: 'User',
	useAsActiveAddress: true,
	askForAddressAccess: true,
}

const recipientEntry: ContactEntry = {
	type: 'contact',
	name: 'Recipient',
	address: RECIPIENT_ADDRESS,
	entrySource: 'OnChain',
}

const rpcNetwork: RpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const blockTimeManipulation: BlockTimeManipulationWithNoDelay = { type: 'No Delay' }

function createPreSimulationTransaction(transactionIdentifier: bigint, method: 'eth_sendTransaction' | 'eth_sendRawTransaction'): PreSimulationTransaction {
	const signedTransaction = mockSignTransaction({
		type: '1559',
		from: ACTIVE_ADDRESS,
		to: RECIPIENT_ADDRESS,
		value: 0n,
		input: new Uint8Array(),
		nonce: transactionIdentifier,
		gas: 21_000n,
		chainId: 1n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
	})
	return {
		signedTransaction,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: method === 'eth_sendRawTransaction'
			? { method, params: [new Uint8Array([1, 2, 3])] }
			: { method, params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array(), nonce: transactionIdentifier, gas: 21_000n, chainId: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }] },
		transactionIdentifier,
	}
}

function createSimulatedTransaction(transactionIdentifier: bigint): SimulatedAndVisualizedTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier,
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array() }] },
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 0n,
		realizedGasPrice: 1n,
		quarantine: false,
		quarantineReasons: [],
		transactionStatus: 'Transaction Succeeded',
		transaction: {
			from: activeAddressEntry,
			to: recipientEntry,
			rpcNetwork,
			type: '1559',
			nonce: transactionIdentifier,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			value: 0n,
			input: new Uint8Array(),
			hash: transactionIdentifier,
		},
		events: [],
	}
}

function createFailedTransaction(transactionIdentifier: bigint): NonSimulatedAndVisualizedTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier,
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array() }] },
		transactionStatus: 'Failed To Simulate',
		error: { code: -32_000, message: 'failed', decodedErrorMessage: 'failed' },
		transaction: {
			from: activeAddressEntry,
			to: recipientEntry,
			rpcNetwork,
			type: '1559',
			nonce: transactionIdentifier,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			value: 0n,
			input: new Uint8Array(),
			hash: transactionIdentifier,
		},
	}
}

function createSignedMessage(messageIdentifier: bigint): SignedMessageTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		fakeSignedFor: ACTIVE_ADDRESS,
		originalRequestParameters: { method: 'personal_sign', params: ['0x', ACTIVE_ADDRESS] },
		request: { method: 'personal_sign', params: ['0x', ACTIVE_ADDRESS] },
		simulationMode: true,
		messageIdentifier,
	}
}

function createVisualizedMessage(messageIdentifier: bigint): VisualizedPersonalSignRequest {
	return {
		activeAddress: activeAddressEntry,
		rpcNetwork,
		simulationMode: true,
		signerName: 'NoSignerDetected',
		quarantineReasons: [],
		quarantine: false,
		account: activeAddressEntry,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		rawMessage: '0x',
		stringifiedMessage: 'hello',
		messageIdentifier,
		method: 'personal_sign',
		type: 'NotParsed',
		message: 'hello',
		messageHash: undefined,
	}
}

function createResults(params: {
	transactions?: readonly PreSimulationTransaction[]
	signedMessages?: readonly SignedMessageTransaction[]
	visualizedTransactions?: readonly (SimulatedAndVisualizedTransaction | NonSimulatedAndVisualizedTransaction)[]
	visualizedMessages?: readonly VisualizedPersonalSignRequest[]
	success?: boolean
}): SimulationAndVisualisationResults {
	return {
		blockNumber: 100n,
		blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
		simulationStateInput: [{
			stateOverrides: {},
			transactions: params.transactions ?? [],
			signedMessages: params.signedMessages ?? [],
			blockTimeManipulation,
			simulateWithZeroBaseFee: false,
		}],
		addressBookEntries: [activeAddressEntry, recipientEntry],
		visualizedSimulationState: params.success === false ? {
			success: false,
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'failed' } },
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: params.visualizedTransactions ?? [],
				visualizedPersonalSignRequests: params.visualizedMessages ?? [],
				blockTimeManipulation,
			}],
		} : {
			success: true,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: params.visualizedTransactions ?? [],
				visualizedPersonalSignRequests: params.visualizedMessages ?? [],
				blockTimeManipulation,
			}],
		},
		rpcNetwork,
		tokenPriceEstimates: [],
		namedTokenIds: [],
	}
}

describe('simulation stack compact summary', () => {
	test('includes the rich-address row from complete visualized simulation', () => {
		const rows = getSimulationStackNameRows(createPassthroughCompleteVisualizedSimulation(1, 'done', 2))
		assert.deepEqual(rows.map((row) => row.title), ['Simply making 2 addresses rich'])
		assert.equal(rows[0]?.kind, 'rich-addresses')
	})

	test('names pending regular and raw transactions', () => {
		const rows = getSimulationStackNameRowsFromResults(createResults({
			transactions: [
				createPreSimulationTransaction(1n, 'eth_sendTransaction'),
				createPreSimulationTransaction(2n, 'eth_sendRawTransaction'),
			],
		}), 0)
		assert.deepEqual(rows.map((row) => row.title), ['Pending transaction', 'Pending raw transaction'])
		assert.deepEqual(rows.map((row) => row.status), ['pending', 'pending'])
	})

	test('uses transaction identification for simulated and failed transactions', () => {
		const successfulRows = getSimulationStackNameRowsFromResults(createResults({
			transactions: [createPreSimulationTransaction(1n, 'eth_sendTransaction')],
			visualizedTransactions: [createSimulatedTransaction(1n)],
		}), 0)
		assert.equal(successfulRows[0]?.title, 'Contract Fallback Method')
		assert.equal(successfulRows[0]?.status, 'simulated')

		const failedRows = getSimulationStackNameRowsFromResults(createResults({
			transactions: [createPreSimulationTransaction(2n, 'eth_sendTransaction')],
			visualizedTransactions: [createFailedTransaction(2n)],
			success: false,
		}), 0)
		assert.equal(failedRows[0]?.title, 'Contract Fallback Method')
		assert.equal(failedRows[0]?.status, 'failed')
	})

	test('names pending and simulated signatures', () => {
		const pendingRows = getSimulationStackNameRowsFromResults(createResults({
			signedMessages: [createSignedMessage(1n)],
		}), 0)
		assert.equal(pendingRows[0]?.title, 'Pending signature')
		assert.equal(pendingRows[0]?.status, 'pending')

		const simulatedRows = getSimulationStackNameRowsFromResults(createResults({
			signedMessages: [createSignedMessage(2n)],
			visualizedMessages: [createVisualizedMessage(2n)],
		}), 0)
		assert.equal(simulatedRows[0]?.title, 'Arbitrary Ethereum message')
		assert.equal(simulatedRows[0]?.status, 'simulated')
	})
})
