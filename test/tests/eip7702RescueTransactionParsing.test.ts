import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addr, authorization as eip7702Authorization, Transaction } from 'micro-eth-signer'
import { type EthereumJsonRpcRequest, SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { WebsiteCreatedEthereumUnsignedTransaction } from '../../app/ts/types/visualizer-types.js'
import { PendingTransactionOrSignableMessage, type PendingTransactionOrSignableMessage as PendingTransactionOrSignableMessageType } from '../../app/ts/types/accessRequest.js'
import { EthereumAddress, EthereumBlockHeader, EthereumBytes32, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { keccak256 } from '../../app/ts/utils/ethereumPrimitives.js'
import { dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { parseSendRawTransaction } from '../../app/ts/utils/sendRawTransactionParsing.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { normalizeEip7702AuthorizationList } from '../../app/ts/utils/eip7702Authorization.js'
import { EthereumSignedTransactionToSignedTransaction, serializeSignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const recipientAddress = '0x0000000000000000000000000000000000000002'
const accessListAddress = '0x0000000000000000000000000000000000000003'
const accessListStorageKey = '0x0000000000000000000000000000000000000000000000000000000000000042'

const privateKeyToTestAccount = (privateKey: `0x${ string }`) => ({
	address: addr.fromPrivateKey(privateKey),
	signAuthorization: async (request: { readonly address: string, readonly chainId: number | bigint, readonly nonce: number | bigint }) => eip7702Authorization.sign({
		address: request.address,
		chainId: BigInt(request.chainId),
		nonce: BigInt(request.nonce),
	}, privateKey),
	signTransaction: async (transaction: {
		readonly type: 'eip1559' | 'eip7702'
		readonly chainId: number | bigint
		readonly nonce: number | bigint
		readonly maxFeePerGas: bigint
		readonly maxPriorityFeePerGas: bigint
		readonly gas: bigint
		readonly to: string
		readonly value: bigint
		readonly data: string
		readonly accessList?: readonly { readonly address: string, readonly storageKeys: readonly string[] }[]
		readonly authorizationList?: readonly ReturnType<typeof eip7702Authorization.sign>[]
	}) => {
		const common = {
			chainId: BigInt(transaction.chainId),
			nonce: BigInt(transaction.nonce),
			maxFeePerGas: transaction.maxFeePerGas,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			data: transaction.data,
			accessList: transaction.accessList?.map((entry) => ({ ...entry, storageKeys: [...entry.storageKeys] })) ?? [],
		}
		const prepared = transaction.type === 'eip7702'
			? Transaction.prepare({ ...common, type: transaction.type, authorizationList: transaction.authorizationList?.map((authorization) => ({ ...authorization })) ?? [] }, false)
			: Transaction.prepare({ ...common, type: transaction.type }, false)
		return prepared.signBy(privateKey).toHex()
	},
})

const rpcNetwork: RpcEntry = {
	name: 'Test Chain',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

function makeFakeBlock(number: bigint) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n + number,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp: new Date('2024-01-01T00:00:00.000Z'),
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

const createEip7702TransactionParsingRequestHandler = () => ({
	rpcUrl: rpcNetwork.httpsRpc,
	clearCache: () => undefined,
	getChainId: async () => rpcNetwork.chainId,
	jsonRpcRequest: async (rpcRequest: EthereumJsonRpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber':
				return serialize(EthereumBlockHeader, makeFakeBlock(1n))
			case 'eth_blockNumber':
				return serialize(EthereumQuantity, 1n)
			case 'eth_getTransactionCount':
				return serialize(EthereumQuantity, 7n)
			case 'eth_getBalance':
				return serialize(EthereumQuantity, 10n ** 18n)
			default:
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
		}
	},
})

type SignedAuthorizationForRpc = {
	readonly chainId: number | bigint
	readonly address: `0x${ string }`
	readonly nonce: number | bigint
	readonly yParity: number
	readonly r: `0x${ string }` | bigint
	readonly s: `0x${ string }` | bigint
}

const signedAuthorizationToRpc = (authorization: SignedAuthorizationForRpc) => ({
	chainId: `0x${ authorization.chainId.toString(16) }`,
	address: authorization.address,
	nonce: `0x${ authorization.nonce.toString(16) }`,
	yParity: authorization.yParity === 0 ? '0x0' : '0x1',
	r: typeof authorization.r === 'bigint' ? `0x${ authorization.r.toString(16) }` : authorization.r,
	s: typeof authorization.s === 'bigint' ? `0x${ authorization.s.toString(16) }` : authorization.s,
})

function restoreGlobalProperty(key: 'browser' | 'chrome', descriptor: PropertyDescriptor | undefined) {
	if (descriptor === undefined) {
		Reflect.deleteProperty(globalThis, key)
		return
	}
	Object.defineProperty(globalThis, key, descriptor)
}

function installExtensionImportGlobals() {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
	Object.defineProperty(globalThis, 'chrome', {
		value: { runtime: { id: 'test-extension' } },
		configurable: true,
		writable: true,
	})
	return () => {
		restoreGlobalProperty('browser', browserDescriptor)
		restoreGlobalProperty('chrome', chromeDescriptor)
	}
}

function installBrowserMock() {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
	const storageState: Record<string, unknown> = {}
	const postedMessages: unknown[] = []
	const browserMock = {
		runtime: {
			lastError: null,
			getManifest: () => ({ manifest_version: 3 }),
			async sendMessage(message: unknown) {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
				}
				return undefined
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async get() { return undefined },
			async update() { return undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
	}
	Object.defineProperty(globalThis, 'browser', {
		value: browserMock,
		configurable: true,
		writable: true,
	})
	Object.defineProperty(globalThis, 'chrome', {
		value: { runtime: { id: 'test-extension' } },
		configurable: true,
		writable: true,
	})
	return {
		postedMessages,
		storageState,
		websiteTabConnections: new Map([[1, {
			connections: {
				'1-0x0': {
					port: {
						name: 'test',
						disconnect: () => undefined,
						postMessage: (message: unknown) => {
							postedMessages.push(message)
						},
						onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
						onMessage: { addListener: () => undefined, removeListener: () => undefined },
					},
					socket: { tabId: 1, connectionName: 0n },
					websiteOrigin: 'https://example.com',
					approved: true,
					wantsToConnect: false,
				},
			},
		}]]),
		restore() {
			restoreGlobalProperty('browser', browserDescriptor)
			restoreGlobalProperty('chrome', chromeDescriptor)
		},
	}
}

function makeSimulatedPendingRawTransaction(transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction) {
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
	const pendingTransaction: PendingTransactionOrSignableMessageType = {
		type: 'Transaction',
		transactionOrMessageCreationStatus: 'Simulated',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters: transactionToSimulate.originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress: transactionToSimulate.transaction.from,
		created: transactionToSimulate.created,
		transactionIdentifier: transactionToSimulate.transactionIdentifier,
		transactionToSimulate,
		website: transactionToSimulate.website,
		approvalStatus: { status: 'WaitingForUser' },
		popupVisualisation: {
			statusCode: 'success',
			data: {
				activeAddress: transactionToSimulate.transaction.from,
				simulationMode: true,
				simulationStartedTimestamp: transactionToSimulate.created,
				uniqueRequestIdentifier,
				transactionToSimulate,
				signerName: 'NoSignerDetected',
				addressBookEntries: [],
				tokenPriceEstimates: [],
				tokenPriceQuoteToken: undefined,
				namedTokenIds: [],
				simulationState: {
					success: true,
					simulationStateInput: [],
					simulatedBlocks: [],
					blockNumber: 1n,
					blockTimestamp: transactionToSimulate.created,
					baseFeePerGas: 1n,
					simulationConductedTimestamp: transactionToSimulate.created,
					rpcNetwork,
				},
				visualizedSimulationState: {
					success: true,
					visualizedBlocks: [],
				},
			},
		},
	}
	return PendingTransactionOrSignableMessage.parse(serialize(PendingTransactionOrSignableMessage, pendingTransaction))
}

async function assertAcceptPreservesRawSignedTransaction(signedTransactionBytes: Uint8Array) {
	const browserMock = installBrowserMock()
	try {
		const [
			{ browserStorageLocalSet2 },
			{ formSendRawTransaction, resolvePendingTransactionOrMessage },
			{ getInterceptorTransactionStack },
		] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/background/windows/confirmTransaction.js'),
			import('../../app/ts/background/storageVariables.js'),
		])
		const request = SendRawTransactionParams.parse({
			method: 'eth_sendRawTransaction',
			params: [dataStringWith0xStart(signedTransactionBytes)],
		})
		const transactionToSimulate = await formSendRawTransaction(
			new EthereumClientService(createEip7702TransactionParsingRequestHandler(), async () => undefined, async () => undefined, rpcNetwork),
			request,
			{ websiteOrigin: 'test', icon: undefined, title: undefined },
			new Date('2024-01-01T00:00:00.000Z'),
			1n,
		)
		const signedTransaction = transactionToSimulate.signedTransaction
		if (signedTransaction === undefined) throw new Error('Expected raw transaction to carry the original signed transaction')
		const pendingTransaction = makeSimulatedPendingRawTransaction(transactionToSimulate)
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })

		await resolvePendingTransactionOrMessage(
			new EthereumClientService(createEip7702TransactionParsingRequestHandler(), async () => undefined, async () => undefined, rpcNetwork),
			{} as never,
			browserMock.websiteTabConnections,
			{ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: pendingTransaction.uniqueRequestIdentifier, action: 'accept' } },
		)

		const [postedMessage] = browserMock.postedMessages
		assert.equal(typeof postedMessage, 'object')
		if (typeof postedMessage !== 'object' || postedMessage === null || !('result' in postedMessage)) throw new Error('Expected a posted transaction result')
		assert.equal(postedMessage.result, EthereumBytes32.serialize(signedTransaction.hash))
		const stack = await getInterceptorTransactionStack()
		const [operation] = stack.operations
		if (operation === undefined || operation.type !== 'Transaction') throw new Error('Expected accepted raw transaction in stack')
		assert.equal(operation.preSimulationTransaction.signedTransaction.hash, signedTransaction.hash)
		assert.equal(operation.preSimulationTransaction.signedTransaction.r, signedTransaction.r)
		assert.equal(operation.preSimulationTransaction.signedTransaction.s, signedTransaction.s)
		assert.notEqual(operation.preSimulationTransaction.signedTransaction.r, 0n)
		assert.notEqual(operation.preSimulationTransaction.signedTransaction.s, 0n)
		if (signedTransaction.type === '7702') {
			if (operation.preSimulationTransaction.signedTransaction.type !== '7702') throw new Error('Expected accepted raw 7702 transaction in stack')
			const [expectedAuthorization] = signedTransaction.authorizationList
			const [actualAuthorization] = operation.preSimulationTransaction.signedTransaction.authorizationList
			if (expectedAuthorization === undefined || actualAuthorization === undefined) throw new Error('Expected accepted raw 7702 authorization in stack')
			assert.equal(actualAuthorization.authority, expectedAuthorization.authority)
			assert.equal(actualAuthorization.r, expectedAuthorization.r)
			assert.equal(actualAuthorization.s, expectedAuthorization.s)
			assert.equal(actualAuthorization.yParity, expectedAuthorization.yParity)
		}
	} finally {
		browserMock.restore()
	}
}

describe('EIP-7702 rescue transaction parsing', () => {
	test('parses eth_sendTransaction authorization lists', () => {
		const parsed = SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				to: recipientAddress,
				value: '0x0',
				authorizationList: [{
					chainId: '0x1',
					address: zeroAddress,
					nonce: '0x5',
					yParity: '0x0',
					r: '0x1',
					s: '0x2',
				}],
			}],
		})

		assert.equal(parsed.params[0].type, '7702')
		const [authorization] = parsed.params[0].authorizationList ?? []
		if (authorization === undefined) throw new Error('Expected authorization to be parsed')
		assert.equal(authorization.address, 0n)
		assert.equal(authorization.nonce, 5n)
		assert.equal(authorization.yParity, 'even')
	})

	test('formEthSendTransaction recovers authorization authority from signed tuples', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const clearDelegationAuthorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: 1,
			nonce: 5,
		})
		const params = SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{
				type: '0x4',
				from: sponsor.address,
				to: recipientAddress,
				value: '0x0',
				gas: '0xc350',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				authorizationList: [signedAuthorizationToRpc(clearDelegationAuthorization)],
			}],
		})
		const restoreGlobals = installExtensionImportGlobals()
		try {
			const { formEthSendTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
			const transaction = await formEthSendTransaction(
				new EthereumClientService(createEip7702TransactionParsingRequestHandler(), async () => undefined, async () => undefined, rpcNetwork),
				undefined,
				EthereumAddress.parse(sponsor.address),
				{ websiteOrigin: 'test', icon: undefined, title: undefined },
				params,
				new Date('2024-01-01T00:00:00.000Z'),
				1n,
				false,
			)

			assert.equal(transaction.success, true)
			if (transaction.success === false) throw new Error('transaction creation unexpectedly failed')
			assert.equal(transaction.transaction.type, '7702')
			if (transaction.transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
			const [authorization] = transaction.transaction.authorizationList
			if (authorization === undefined) throw new Error('Expected authorization to be parsed')
			assert.equal(authorization.authority, EthereumAddress.parse(victim.address))
			assert.equal(authorization.r, BigInt(clearDelegationAuthorization.r))
			assert.equal(authorization.s, BigInt(clearDelegationAuthorization.s))
			assert.equal(authorization.yParity, clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd')
		} finally {
			restoreGlobals()
		}
	})

	test('formEthSendTransaction recovers signed authorization authority over supplied authority', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const suppliedAuthority = '0x0000000000000000000000000000000000000004'
		const clearDelegationAuthorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: 1,
			nonce: 5,
		})
		const params = SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{
				type: '0x4',
				from: sponsor.address,
				to: recipientAddress,
				value: '0x0',
				gas: '0xc350',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				authorizationList: [{
					...signedAuthorizationToRpc(clearDelegationAuthorization),
					authority: suppliedAuthority,
				}],
			}],
		})
		const [parsedAuthorization] = params.params[0].authorizationList ?? []
		if (parsedAuthorization === undefined) throw new Error('Expected authorization to be parsed')
		assert.equal('authority' in parsedAuthorization, false)
		const restoreGlobals = installExtensionImportGlobals()
		try {
			const { formEthSendTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
			const transaction = await formEthSendTransaction(
				new EthereumClientService(createEip7702TransactionParsingRequestHandler(), async () => undefined, async () => undefined, rpcNetwork),
				undefined,
				EthereumAddress.parse(sponsor.address),
				{ websiteOrigin: 'test', icon: undefined, title: undefined },
				params,
				new Date('2024-01-01T00:00:00.000Z'),
				1n,
				false,
			)

			assert.equal(transaction.success, true)
			if (transaction.success === false) throw new Error('transaction creation unexpectedly failed')
			if (transaction.transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
			const [authorization] = transaction.transaction.authorizationList
			if (authorization === undefined) throw new Error('Expected authorization to be parsed')
			assert.equal(authorization.authority, EthereumAddress.parse(victim.address))
			assert.equal(authorization.r, BigInt(clearDelegationAuthorization.r))
			assert.equal(authorization.s, BigInt(clearDelegationAuthorization.s))
			assert.equal(authorization.yParity, clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd')
		} finally {
			restoreGlobals()
		}
	})

	test('normalizing partial signed authorizations rejects supplied authority fallback', async () => {
		await assert.rejects(
			async () => await normalizeEip7702AuthorizationList([{
				chainId: 1n,
				address: 0n,
				nonce: 5n,
				authority: 0x0000000000000000000000000000000000000004n,
				r: 1n,
				s: 2n,
			}]),
			/EIP-7702 authorization signature is missing required fields/
		)
	})

	test('normalizing signed authorizations preserves valid bigint chain ids and nonces', async () => {
		const largeValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const signedAuthorization = await victim.signAuthorization({ address: zeroAddress, chainId: largeValue, nonce: largeValue })
		const [normalized] = await normalizeEip7702AuthorizationList([{
			...signedAuthorization,
			address: BigInt(signedAuthorization.address),
			yParity: signedAuthorization.yParity === 0 ? 'even' : 'odd',
		}])
		if (normalized === undefined) throw new Error('Expected normalized authorization')
		assert.equal(normalized.chainId, largeValue)
		assert.equal(normalized.nonce, largeValue)
		assert.equal(normalized.authority, EthereumAddress.parse(victim.address))
	})

	test('parses raw EIP-7702 transactions and recovers authorization authority', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const clearDelegationAuthorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: 1,
			nonce: 5,
		})
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip7702',
			chainId: 5,
			nonce: 7,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
			accessList: [{
				address: accessListAddress,
				storageKeys: [accessListStorageKey],
			}],
			authorizationList: [clearDelegationAuthorization],
		})

		const parsedTransaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction))
		const transaction = parsedTransaction.transaction

		assert.equal(transaction.type, '7702')
		if (transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
		assert.equal(parsedTransaction.signedTransaction.type, '7702')
		if (parsedTransaction.signedTransaction.type !== '7702') throw new Error('Expected a signed 7702 transaction')
		assert.equal(transaction.from, EthereumAddress.parse(sponsor.address))
		assert.equal(transaction.chainId, 5n)
		assert.equal(transaction.nonce, 7n)
		assert.equal(parsedTransaction.signedTransaction.hash, EthereumBytes32.parse(keccak256(stringToUint8Array(signedTransaction))))
		assert.notEqual(parsedTransaction.signedTransaction.r, 0n)
		assert.notEqual(parsedTransaction.signedTransaction.s, 0n)
		assert.deepEqual(transaction.accessList, [{
			address: EthereumAddress.parse(accessListAddress),
			storageKeys: [EthereumBytes32.parse(accessListStorageKey)],
		}])
		const [authorization] = transaction.authorizationList
		if (authorization === undefined) throw new Error('Expected authorization to be parsed')
		assert.equal(authorization.address, 0n)
		assert.equal(authorization.nonce, 5n)
		assert.equal(authorization.authority, EthereumAddress.parse(victim.address))
		assert.equal(authorization.r, BigInt(clearDelegationAuthorization.r))
		assert.equal(authorization.s, BigInt(clearDelegationAuthorization.s))
		assert.equal(authorization.yParity, clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd')
		const [signedAuthorization] = parsedTransaction.signedTransaction.authorizationList
		if (signedAuthorization === undefined) throw new Error('Expected signed authorization to be parsed')
		assert.equal(signedAuthorization.r, BigInt(clearDelegationAuthorization.r))
		assert.equal(signedAuthorization.s, BigInt(clearDelegationAuthorization.s))
	})

	test('preserves raw EIP-7702 chain IDs and nonces above Number.MAX_SAFE_INTEGER', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const largeValue = BigInt(Number.MAX_SAFE_INTEGER) + 2n
		const authorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: largeValue,
			nonce: largeValue,
		})
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip7702',
			chainId: largeValue,
			nonce: largeValue,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
			authorizationList: [authorization],
		})

		const parsedTransaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction))
		assert.equal(parsedTransaction.transaction.chainId, largeValue)
		assert.equal(parsedTransaction.transaction.nonce, largeValue)
		assert.equal(parsedTransaction.transaction.type, '7702')
		if (parsedTransaction.transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
		assert.equal(parsedTransaction.transaction.authorizationList[0]?.chainId, largeValue)
		assert.equal(parsedTransaction.transaction.authorizationList[0]?.nonce, largeValue)
		assert.equal(dataStringWith0xStart(serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(parsedTransaction.signedTransaction))), signedTransaction)
	})

	test('parses raw EIP-1559 transactions with signed chain and access list', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip1559',
			chainId: 5,
			nonce: 7,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
			accessList: [{
				address: accessListAddress,
				storageKeys: [accessListStorageKey],
			}],
		})

		const parsedTransaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction))
		const transaction = parsedTransaction.transaction

		assert.equal(transaction.type, '1559')
		if (transaction.type !== '1559') throw new Error('Expected a 1559 transaction')
		assert.equal(parsedTransaction.signedTransaction.type, '1559')
		if (parsedTransaction.signedTransaction.type !== '1559') throw new Error('Expected a signed 1559 transaction')
		assert.equal(transaction.from, EthereumAddress.parse(sponsor.address))
		assert.equal(transaction.chainId, 5n)
		assert.equal(transaction.nonce, 7n)
		assert.equal(parsedTransaction.signedTransaction.hash, EthereumBytes32.parse(keccak256(stringToUint8Array(signedTransaction))))
		assert.notEqual(parsedTransaction.signedTransaction.r, 0n)
		assert.notEqual(parsedTransaction.signedTransaction.s, 0n)
		assert.deepEqual(transaction.accessList, [{
			address: EthereumAddress.parse(accessListAddress),
			storageKeys: [EthereumBytes32.parse(accessListStorageKey)],
		}])
	})

	test('accepting a raw EIP-1559 transaction preserves the original signed transaction hash', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip1559',
			chainId: 5,
			nonce: 7,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
		})

		await assertAcceptPreservesRawSignedTransaction(stringToUint8Array(signedTransaction))
	})

	test('accepting a raw EIP-7702 transaction preserves the original signed transaction hash and authorizations', async () => {
		const sponsor = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToTestAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
		const clearDelegationAuthorization = await victim.signAuthorization({
			address: zeroAddress,
			chainId: 5,
			nonce: 5,
		})
		const signedTransaction = await sponsor.signTransaction({
			type: 'eip7702',
			chainId: 5,
			nonce: 7,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			gas: 50_000n,
			to: recipientAddress,
			value: 0n,
			data: '0x',
			authorizationList: [clearDelegationAuthorization],
		})

		await assertAcceptPreservesRawSignedTransaction(stringToUint8Array(signedTransaction))
	})

})
