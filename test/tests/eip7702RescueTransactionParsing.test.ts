import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { type EthereumJsonRpcRequest, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumAddress, EthereumBlockHeader, EthereumBytes32, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { privateKeyToAccount } from '../../app/ts/utils/viem.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { parseSendRawTransaction } from '../../app/ts/utils/sendRawTransactionParsing.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { normalizeEip7702AuthorizationList } from '../../app/ts/utils/eip7702Authorization.js'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const recipientAddress = '0x0000000000000000000000000000000000000002'
const accessListAddress = '0x0000000000000000000000000000000000000003'
const accessListStorageKey = '0x0000000000000000000000000000000000000000000000000000000000000042'

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
	readonly chainId: number
	readonly address: `0x${ string }`
	readonly nonce: number
	readonly yParity: number
	readonly r: `0x${ string }`
	readonly s: `0x${ string }`
}

const signedAuthorizationToRpc = (authorization: SignedAuthorizationForRpc) => ({
	chainId: `0x${ authorization.chainId.toString(16) }`,
	address: authorization.address,
	nonce: `0x${ authorization.nonce.toString(16) }`,
	yParity: authorization.yParity === 0 ? '0x0' : '0x1',
	r: authorization.r,
	s: authorization.s,
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
		const sponsor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
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
		const sponsor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
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

	test('normalizing signed authorizations rejects unsafe chain id and nonce values', async () => {
		const unsafeValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n
		await assert.rejects(
			async () => await normalizeEip7702AuthorizationList([{
				chainId: unsafeValue,
				address: 0n,
				nonce: 5n,
				r: 1n,
				s: 2n,
				yParity: 'even',
			}]),
			/EIP-7702 authorization chainId exceeds the maximum safe integer/
		)
		await assert.rejects(
			async () => await normalizeEip7702AuthorizationList([{
				chainId: 1n,
				address: 0n,
				nonce: unsafeValue,
				r: 1n,
				s: 2n,
				yParity: 'even',
			}]),
			/EIP-7702 authorization nonce exceeds the maximum safe integer/
		)
	})

	test('parses raw EIP-7702 transactions and recovers authorization authority', async () => {
		const sponsor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
		const victim = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
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

		const transaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction))

		assert.equal(transaction.type, '7702')
		if (transaction.type !== '7702') throw new Error('Expected a 7702 transaction')
		assert.equal(transaction.from, EthereumAddress.parse(sponsor.address))
		assert.equal(transaction.chainId, 5n)
		assert.equal(transaction.nonce, 7n)
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
	})

	test('parses raw EIP-1559 transactions with signed chain and access list', async () => {
		const sponsor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
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

		const transaction = await parseSendRawTransaction(stringToUint8Array(signedTransaction))

		assert.equal(transaction.type, '1559')
		if (transaction.type !== '1559') throw new Error('Expected a 1559 transaction')
		assert.equal(transaction.from, EthereumAddress.parse(sponsor.address))
		assert.equal(transaction.chainId, 5n)
		assert.equal(transaction.nonce, 7n)
		assert.deepEqual(transaction.accessList, [{
			address: EthereumAddress.parse(accessListAddress),
			storageKeys: [EthereumBytes32.parse(accessListStorageKey)],
		}])
	})

})
