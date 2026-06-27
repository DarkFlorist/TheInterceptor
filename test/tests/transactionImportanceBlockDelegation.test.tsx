import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { TransactionImportanceBlock } from '../../app/ts/components/simulationExplaining/Transactions.js'
import { identifyTransaction } from '../../app/ts/components/simulationExplaining/identifyTransaction.js'
import { installDomMock } from './domMock.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { MaybeSimulatedTransaction, TokenBalancesAfter } from '../../app/ts/types/visualizer-types.js'
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

const proxyEntry: AddressBookEntry = {
	type: 'contract',
	name: 'Payment proxy',
	address: 0x5555555555555555555555555555555555555555n,
	entrySource: 'OnChain',
}

const contactIntermediateEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Non-contract intermediary',
	address: 0x5555555555555555555555555555555555555556n,
	entrySource: 'User',
}

const feeCollectorEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Fee collector',
	address: 0x6666666666666666666666666666666666666666n,
	entrySource: 'User',
}

const secondRecipientEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Second recipient',
	address: 0x7777777777777777777777777777777777777777n,
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

const erc20TokenEntry: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Mock Token',
	symbol: 'MOCK',
	decimals: 18n,
	address: 0x8888888888888888888888888888888888888888n,
	entrySource: 'User',
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

const eth = 10n ** 18n

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

function createProxyPaymentTransaction({
	events,
	to = proxyEntry,
	value = 100n,
	tokenBalancesAfter = [],
}: {
	events: readonly TokenEvent[]
	to?: AddressBookEntry
	value?: bigint
	tokenBalancesAfter?: TokenBalancesAfter
}): MaybeSimulatedTransaction {
	return {
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
		transactionIdentifier: 3n,
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [{
				from: senderEntry.address,
				to: to.address,
				value,
				input: new Uint8Array(),
				gas: 21_000n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				type: '0x2',
			}],
		},
		transaction: {
			from: senderEntry,
			to,
			value,
			input: new Uint8Array(),
			rpcNetwork,
			hash: 0x1236n,
			gas: 21_000n,
			nonce: 9n,
			type: '1559',
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		},
		transactionStatus: 'Transaction Succeeded',
		tokenBalancesAfter,
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 0n,
		realizedGasPrice: 1n,
		quarantine: false,
		quarantineReasons: [],
		events,
	}
}

function createTransferEvent({
	from,
	to,
	amount,
	token = nativeTokenEntry,
}: {
	from: AddressBookEntry
	to: AddressBookEntry
	amount: bigint
	token?: Erc20TokenEntry
}): TokenEvent {
	return {
		type: 'TokenEvent',
		isParsed: 'Parsed',
		name: 'Transfer',
		signature: 'Transfer(address,address,uint256)',
		args: [],
		address: token.address,
		loggersAddressBookEntry: token,
		data: new Uint8Array(),
		topics: [],
		logInformation: {
			type: 'ERC20',
			logObject: undefined,
			from,
			to,
			token,
			amount,
			isApproval: false,
		},
	}
}

function createNativeTransferEvent(): TokenEvent {
	return createTransferEvent({ from: senderEntry, to: recipientEntry, amount: 1n })
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

const renderedText = (dom: ReturnType<typeof installDomMock>) => dom.document.body.textContent?.replace(/\s+/g, '') ?? ''

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

describe('TransactionImportanceBlock proxied transfers', () => {
	test('renders retained-fee proxied ETH payments as transfers to the final recipient', async () => {
		const transaction = createProxyPaymentTransaction({
			events: [
				createTransferEvent({ from: senderEntry, to: proxyEntry, amount: 100n * eth }),
				createTransferEvent({ from: proxyEntry, to: recipientEntry, amount: 95n * eth }),
			],
		})
		const identified = identifyTransaction(transaction)

		assert.equal(identified.type, 'ProxyTokenTransfer')
		if (identified.type !== 'ProxyTokenTransfer') throw new Error('Expected proxy transfer identification')
		assert.equal(identified.title, 'ETH Transfer with fee via Proxy')
		assert.equal(identified.identifiedTransaction.transferedFrom.amountDelta, 100n * eth)
		assert.deepEqual(identified.identifiedTransaction.transferedTo.map(({ entry, amountDelta }) => ({ address: entry.address, amountDelta })), [
			{ address: recipientEntry.address, amountDelta: 95n * eth },
		])

		const dom = await renderImportanceBlock(transaction, [senderEntry, proxyEntry, recipientEntry, nativeTokenEntry])
		const text = renderedText(dom)

		assert.equal(text.includes('Send100ETH'), true)
		assert.equal(text.includes('Receive95ETH'), true)
		assert.equal(text.includes('Finalrecipient'), true)
		assert.equal(text.includes('Actualrecipient'), true)
		assert.equal(text.includes('Paymentproxy'), true)

		dom.restore()
	})

	test('treats small explicit forwarding recipients as payment fees', async () => {
		const transaction = createProxyPaymentTransaction({
			events: [
				createTransferEvent({ from: senderEntry, to: proxyEntry, amount: 100n * eth }),
				createTransferEvent({ from: proxyEntry, to: recipientEntry, amount: 95n * eth }),
				createTransferEvent({ from: proxyEntry, to: feeCollectorEntry, amount: 5n * eth }),
			],
		})
		const identified = identifyTransaction(transaction)

		assert.equal(identified.type, 'ProxyTokenTransfer')
		if (identified.type !== 'ProxyTokenTransfer') throw new Error('Expected proxy transfer identification')
		assert.equal(identified.title, 'ETH Transfer with fee via Proxy')
		assert.deepEqual(identified.identifiedTransaction.transferedTo.map(({ entry, amountDelta }) => ({ address: entry.address, amountDelta })), [
			{ address: recipientEntry.address, amountDelta: 95n * eth },
		])

		const dom = await renderImportanceBlock(transaction, [senderEntry, proxyEntry, recipientEntry, feeCollectorEntry, nativeTokenEntry])
		const text = renderedText(dom)

		assert.equal(text.includes('Send100ETH'), true)
		assert.equal(text.includes('Receive95ETH'), true)
		assert.equal(text.includes('Actualrecipient'), true)
		assert.equal(text.includes('Feecollector'), false)

		dom.restore()
	})

	test('renders retained-fee proxied ERC20 payments as token transfers to the final recipient', async () => {
		const transaction = createProxyPaymentTransaction({
			value: 0n,
			events: [
				createTransferEvent({ from: senderEntry, to: proxyEntry, amount: 100n * eth, token: erc20TokenEntry }),
				createTransferEvent({ from: proxyEntry, to: recipientEntry, amount: 95n * eth, token: erc20TokenEntry }),
			],
		})
		const identified = identifyTransaction(transaction)

		assert.equal(identified.type, 'ProxyTokenTransfer')
		if (identified.type !== 'ProxyTokenTransfer') throw new Error('Expected proxy transfer identification')
		assert.equal(identified.title, 'MOCK Transfer with fee via Proxy')
		assert.equal(identified.identifiedTransaction.transferedFrom.amountDelta, 100n * eth)
		assert.deepEqual(identified.identifiedTransaction.transferedTo.map(({ entry, amountDelta }) => ({ address: entry.address, amountDelta })), [
			{ address: recipientEntry.address, amountDelta: 95n * eth },
		])

		const dom = await renderImportanceBlock(transaction, [senderEntry, proxyEntry, recipientEntry, erc20TokenEntry])
		const text = renderedText(dom)

		assert.equal(text.includes('Send100MOCK'), true)
		assert.equal(text.includes('Receive95MOCK'), true)
		assert.equal(text.includes('Finalrecipient'), true)
		assert.equal(text.includes('Actualrecipient'), true)
		assert.equal(text.includes('Paymentproxy'), true)

		dom.restore()
	})

	test('renders exact proxy multisends as transfers to multiple final recipients', async () => {
		const transaction = createProxyPaymentTransaction({
			events: [
				createTransferEvent({ from: senderEntry, to: proxyEntry, amount: 100n * eth }),
				createTransferEvent({ from: proxyEntry, to: recipientEntry, amount: 40n * eth }),
				createTransferEvent({ from: proxyEntry, to: secondRecipientEntry, amount: 60n * eth }),
			],
		})
		const identified = identifyTransaction(transaction)

		assert.equal(identified.type, 'ProxyTokenTransfer')
		if (identified.type !== 'ProxyTokenTransfer') throw new Error('Expected proxy transfer identification')
		assert.equal(identified.title, 'ETH Transfer to many via Proxy')
		assert.deepEqual(identified.identifiedTransaction.transferedTo.map(({ entry, amountDelta }) => ({ address: entry.address, amountDelta })), [
			{ address: recipientEntry.address, amountDelta: 40n * eth },
			{ address: secondRecipientEntry.address, amountDelta: 60n * eth },
		])

		const dom = await renderImportanceBlock(transaction, [senderEntry, proxyEntry, recipientEntry, secondRecipientEntry, nativeTokenEntry])
		const text = renderedText(dom)

		assert.equal(text.includes('Send100ETH'), true)
		assert.equal(text.includes('Receive40ETH'), true)
		assert.equal(text.includes('Receive60ETH'), true)
		assert.equal(text.includes('Finalrecipients'), true)
		assert.equal(text.includes('Actualrecipient'), true)
		assert.equal(text.includes('Secondrecipient'), true)

		dom.restore()
	})

	test('treats small explicit fee recipients separately from multisend payment recipients', async () => {
		const transaction = createProxyPaymentTransaction({
			events: [
				createTransferEvent({ from: senderEntry, to: proxyEntry, amount: 100n * eth }),
				createTransferEvent({ from: proxyEntry, to: recipientEntry, amount: 50n * eth }),
				createTransferEvent({ from: proxyEntry, to: secondRecipientEntry, amount: 45n * eth }),
				createTransferEvent({ from: proxyEntry, to: feeCollectorEntry, amount: 5n * eth }),
			],
		})
		const identified = identifyTransaction(transaction)

		assert.equal(identified.type, 'ProxyTokenTransfer')
		if (identified.type !== 'ProxyTokenTransfer') throw new Error('Expected proxy transfer identification')
		assert.equal(identified.title, 'ETH Transfer to many with fee via Proxy')
		assert.deepEqual(identified.identifiedTransaction.transferedTo.map(({ entry, amountDelta }) => ({ address: entry.address, amountDelta })), [
			{ address: recipientEntry.address, amountDelta: 50n * eth },
			{ address: secondRecipientEntry.address, amountDelta: 45n * eth },
		])

		const dom = await renderImportanceBlock(transaction, [senderEntry, proxyEntry, recipientEntry, secondRecipientEntry, feeCollectorEntry, nativeTokenEntry])
		const text = renderedText(dom)

		assert.equal(text.includes('Send100ETH'), true)
		assert.equal(text.includes('Receive50ETH'), true)
		assert.equal(text.includes('Receive45ETH'), true)
		assert.equal(text.includes('Finalrecipients'), true)
		assert.equal(text.includes('Actualrecipient'), true)
		assert.equal(text.includes('Secondrecipient'), true)
		assert.equal(text.includes('Feecollector'), false)

		dom.restore()
	})

	test('does not treat non-contract intermediaries as payment proxies', () => {
		const transaction = createProxyPaymentTransaction({
			to: contactIntermediateEntry,
			events: [
				createTransferEvent({ from: senderEntry, to: contactIntermediateEntry, amount: 100n * eth }),
				createTransferEvent({ from: contactIntermediateEntry, to: recipientEntry, amount: 100n * eth }),
			],
		})

		assert.notEqual(identifyTransaction(transaction).type, 'ProxyTokenTransfer')
	})
})
