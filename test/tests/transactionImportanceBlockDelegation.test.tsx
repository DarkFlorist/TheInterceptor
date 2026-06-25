import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { TransactionImportanceBlock } from '../../app/ts/components/simulationExplaining/Transactions.js'
import { installDomMock } from './domMock.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { MaybeSimulatedTransaction } from '../../app/ts/types/visualizer-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'

const senderEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Public private key',
	address: 0x1111111111111111111111111111111111111111n,
	entrySource: 'User',
}

const delegateEntry: AddressBookEntry = {
	type: 'contract',
	name: 'Delegated Executor',
	address: 0x2222222222222222222222222222222222222222n,
	entrySource: 'OnChain',
}

const secondDelegateEntry: AddressBookEntry = {
	type: 'contract',
	name: 'Delegated Executor 2',
	address: 0x3333333333333333333333333333333333333333n,
	entrySource: 'OnChain',
}

const recipientEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Actual recipient',
	address: 0x4444444444444444444444444444444444444444n,
	entrySource: 'User',
}

const nativeTokenEntry: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Ether',
	symbol: 'ETH',
	decimals: 18n,
	address: ETHEREUM_LOGS_LOGGER_ADDRESS,
	entrySource: 'Interceptor',
}

const rpcNetwork: RpcNetwork = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

function createAuthorization(address: bigint, nonce: bigint) {
	return {
		chainId: 1n,
		address,
		nonce,
		r: 1n,
		s: 2n,
		yParity: 'even' as const,
	}
}

function create7702Transaction({
	status,
	authorizationAddresses,
	events = [],
}: {
	status: MaybeSimulatedTransaction['transactionStatus']
	authorizationAddresses: readonly bigint[]
	events?: readonly TokenEvent[]
}): MaybeSimulatedTransaction {
	const base = {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
		transactionIdentifier: 1n,
		originalRequestParameters: {
			method: 'eth_sendTransaction' as const,
			params: [{
				from: senderEntry.address,
				to: senderEntry.address,
				value: 0n,
				input: new Uint8Array(),
				gas: 21_000n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				type: '0x4' as const,
				authorizationList: authorizationAddresses.map((address, index) => createAuthorization(address, BigInt(index + 1))),
			}],
		},
		transaction: {
			from: senderEntry,
			to: senderEntry,
			value: 0n,
			input: new Uint8Array(),
			rpcNetwork,
			hash: 0x1234n,
			gas: 21_000n,
			nonce: 7n,
			type: '7702' as const,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			authorizationList: authorizationAddresses.map((address, index) => createAuthorization(address, BigInt(index + 1))),
		},
	}

	switch (status) {
		case 'Failed To Simulate':
			return {
				...base,
				transactionStatus: 'Failed To Simulate',
				error: {
					code: -32000,
					message: 'Failed to simulate',
					data: undefined,
					decodedErrorMessage: 'Failed to simulate',
				},
			}
		case 'Transaction Failed':
			return {
				...base,
				transactionStatus: 'Transaction Failed',
				tokenBalancesAfter: [],
				tokenPriceEstimates: [],
				tokenPriceQuoteToken: undefined,
				gasSpent: 0n,
				realizedGasPrice: 1n,
				quarantine: false,
				quarantineReasons: [],
				events: [],
				error: {
					code: -32000,
					message: 'execution reverted',
					data: undefined,
					decodedErrorMessage: 'execution reverted',
				},
			}
		case 'Transaction Succeeded':
			return {
				...base,
				transactionStatus: 'Transaction Succeeded',
				tokenBalancesAfter: [],
				tokenPriceEstimates: [],
				tokenPriceQuoteToken: undefined,
				gasSpent: 0n,
				realizedGasPrice: 1n,
				quarantine: false,
				quarantineReasons: [],
				events,
			}
	}
}

function createDelegatedSelfCallTransaction({
	events = [],
}: {
	events?: readonly TokenEvent[]
}): MaybeSimulatedTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier: 2n,
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [{
				from: senderEntry.address,
				to: senderEntry.address,
				value: 1n,
				input: new Uint8Array(),
				gas: 21_000n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				type: '0x2',
			}],
		},
		transaction: {
			from: senderEntry,
			to: senderEntry,
			delegationAddress: delegateEntry,
			value: 1n,
			input: new Uint8Array(),
			rpcNetwork,
			hash: 0x1235n,
			gas: 21_000n,
			nonce: 8n,
			type: '1559',
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		},
		transactionStatus: 'Transaction Succeeded',
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 0n,
		realizedGasPrice: 1n,
		quarantine: false,
		quarantineReasons: [],
		events,
	}
}

function createNativeTransferEvent(): TokenEvent {
	return {
		type: 'TokenEvent',
		isParsed: 'Parsed',
		name: 'Transfer',
		signature: 'Transfer(address,address,uint256)',
		args: [],
		address: nativeTokenEntry.address,
		loggersAddressBookEntry: nativeTokenEntry,
		data: new Uint8Array(),
		topics: [],
		logInformation: {
			type: 'ERC20',
			logObject: undefined,
			from: senderEntry,
			to: recipientEntry,
			token: nativeTokenEntry,
			amount: 1n,
			isApproval: false,
		},
	}
}

async function renderImportanceBlock(simTx: MaybeSimulatedTransaction, addressMetadata: readonly AddressBookEntry[]) {
	const dom = installDomMock()

	await act(() => {
		render(h(TransactionImportanceBlock, {
			simTx,
			activeAddress: new Signal<bigint | undefined>(senderEntry.address),
			renameAddressCallBack: () => undefined,
			editEnsNamedHashCallBack: () => undefined,
			addressMetadata: new Signal(addressMetadata),
			rpcNetwork: new Signal(rpcNetwork),
		}), dom.document.body)
	})

	return dom
}

describe('TransactionImportanceBlock delegation notice', () => {
	test('shows authorization flow details for failed-to-simulate 7702 transactions', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({ status: 'Failed To Simulate', authorizationAddresses: [delegateEntry.address] }),
			[senderEntry, delegateEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('delegated to'), true)
		assert.equal(dom.document.body.textContent?.includes('Delegated Executor'), true)
		assert.equal(dom.document.body.textContent?.includes('Failed to simulate this transaction.'), true)

		dom.restore()
	})

	test('shows authorization flow details for failed 7702 transactions', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({ status: 'Transaction Failed', authorizationAddresses: [delegateEntry.address] }),
			[senderEntry, delegateEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('delegated to'), true)
		assert.equal(dom.document.body.textContent?.includes('execution reverted'), true)

		dom.restore()
	})

	test('shows authorization flow details for successful 7702 self-calls', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({ status: 'Transaction Succeeded', authorizationAddresses: [delegateEntry.address] }),
			[senderEntry, delegateEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('delegated to'), true)
		assert.equal(dom.document.body.textContent?.includes('The transaction does no visible important changes to your accounts.'), true)

		dom.restore()
	})

	test('shows multiple authorization targets when present', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({ status: 'Transaction Succeeded', authorizationAddresses: [delegateEntry.address, secondDelegateEntry.address] }),
			[senderEntry, delegateEntry, secondDelegateEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('delegated to'), true)
		assert.equal(dom.document.body.textContent?.includes('Delegated Executor'), true)
		assert.equal(dom.document.body.textContent?.includes('Delegated Executor 2'), true)

		dom.restore()
	})

	test('labels zero-address authorizations as delegate clears', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({ status: 'Transaction Succeeded', authorizationAddresses: [0n] }),
			[senderEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('cleared delegate'), true)
		assert.equal(dom.document.body.textContent?.includes('delegated to'), false)

		dom.restore()
	})

	test('shows the delegated transfer flow together with the executed send outcome', async () => {
		const dom = await renderImportanceBlock(
			create7702Transaction({
				status: 'Transaction Succeeded',
				authorizationAddresses: [delegateEntry.address],
				events: [createNativeTransferEvent()],
			}),
			[senderEntry, delegateEntry, recipientEntry, nativeTokenEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('delegated to'), true)
		assert.equal(dom.document.body.textContent?.includes('Send'), true)
		assert.equal(dom.document.body.textContent?.includes('Funds sent to'), true)
		assert.equal(dom.document.body.textContent?.includes('Actual recipient'), true)

		dom.restore()
	})

	test('shows delegation flow for a regular self-call from an already delegated sender', async () => {
		const dom = await renderImportanceBlock(
			createDelegatedSelfCallTransaction({
				events: [createNativeTransferEvent()],
			}),
			[senderEntry, delegateEntry, recipientEntry, nativeTokenEntry],
		)

		assert.equal(dom.document.body.textContent?.includes('Delegated execution'), true)
		assert.equal(dom.document.body.textContent?.includes('Funds sent to'), true)
		assert.equal(dom.document.body.textContent?.includes('Delegated Executor'), true)
		assert.equal(dom.document.body.textContent?.includes('Actual recipient'), true)
		assert.equal(dom.document.body.textContent?.includes('Send'), true)

		dom.restore()
	})
})
