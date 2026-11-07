import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { canonicalizeWalletSendCalls, doWalletSendCallsMatchSimulatedTransactions, getSigningModeWalletCallsReply, getWalletSendCallsParseFailureReply, getWalletSendCallsTransactionParams, WALLET_SEND_CALLS_MAX_CALLS } from '../../app/ts/background/walletSendCalls.js'
import { EthereumJsonRpcRequest, WalletSendCalls } from '../../app/ts/types/JsonRpc-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const account = 0x1111111111111111111111111111111111111111n
const otherAccount = 0x2222222222222222222222222222222222222222n
const firstRecipient = 0x3333333333333333333333333333333333333333n
const secondRecipient = 0x4444444444444444444444444444444444444444n
const chainId = 1n

const createRequest = (batchOverrides: Record<string, unknown> = {}, calls: readonly Record<string, unknown>[] = [
	{ to: addressString(firstRecipient), value: '0x1' },
	{ to: addressString(secondRecipient), data: '0xa9059cbb' },
]) => ({
	method: 'wallet_sendCalls',
	params: [{
		version: '2.0.0',
		chainId: '0x1',
		atomicRequired: false,
		calls,
		...batchOverrides,
	}],
})

const parseRequest = (request: unknown) => {
	const parsed = WalletSendCalls.safeParse(request)
	if (!parsed.success) throw new Error(`Expected a valid wallet_sendCalls request: ${ parsed.message }`)
	return parsed.value
}

const createInterceptedRequest = (request: { readonly method: string, readonly params: unknown[] }) => ({
	...request,
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
})

describe('wallet_sendCalls request validation', () => {
	test('parses version 2.0.0 requests and every call field', () => {
		const request = EthereumJsonRpcRequest.parse(createRequest({ from: addressString(account), id: '0x01', capabilities: { paymasterService: { optional: true, url: 'https://paymaster.example' } } }))
		if (request.method !== 'wallet_sendCalls') throw new Error('Unexpected request type')
		const [batch] = request.params
		assert.equal(batch.from, account)
		assert.equal(batch.chainId, chainId)
		assert.equal(batch.id, '0x01')
		assert.deepEqual(batch.calls.map((call) => [call.to, call.value, call.data]), [
			[firstRecipient, 1n, undefined],
			[secondRecipient, undefined, Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb])],
		])
	})

	test('rejects unsupported versions and malformed call fields instead of treating them as unknown methods', () => {
		const invalidRequests = [
			createRequest({ version: '1.0' }),
			createRequest({ chainId: '0x01' }),
			createRequest({ atomicRequired: undefined }),
			createRequest({ unexpected: true }),
			createRequest({}, [{ to: '0x1234' }]),
			createRequest({}, [{ to: addressString(firstRecipient), data: 'a9059cbb' }]),
			createRequest({}, [{ to: addressString(firstRecipient), data: '0xabc' }]),
			createRequest({}, [{ to: addressString(firstRecipient), value: '1' }]),
			createRequest({}, [{ to: addressString(firstRecipient), gas: '0x5208' }]),
			createRequest({}, [{ to: addressString(firstRecipient), capabilities: { paymasterService: true } }]),
		]
		for (const invalidRequest of invalidRequests) {
			assert.equal(EthereumJsonRpcRequest.safeParse(invalidRequest).success, false, JSON.stringify(invalidRequest))
			assert.equal(getWalletSendCallsParseFailureReply(createInterceptedRequest(invalidRequest))?.type, 'result')
		}
		assert.deepEqual(getWalletSendCallsParseFailureReply(createInterceptedRequest(createRequest({ version: '1.0' }))), {
			type: 'result',
			method: 'wallet_sendCalls',
			error: { code: -32602, message: 'Unsupported wallet_sendCalls version 1.0. The Interceptor supports EIP-5792 version 2.0.0.' },
		})
		for (const malformedRequest of [createRequest({ chainId: '0x01' }), createRequest({ atomicRequired: undefined })]) {
			const reply = getWalletSendCallsParseFailureReply(createInterceptedRequest(malformedRequest))
			const message = reply?.type === 'result' && 'error' in reply ? reply.error.message : ''
			assert.match(message, /^Invalid wallet_sendCalls version 2\.0\.0 parameters: chainId, atomicRequired and calls are required/u)
		}
		assert.equal(getWalletSendCallsParseFailureReply(createInterceptedRequest({ method: 'wallet_getCallsStatus', params: [5] }))?.type, 'result')
		assert.equal(getWalletSendCallsParseFailureReply(createInterceptedRequest({ method: 'eth_sendTransaction', params: [] })), undefined)
	})

	test('canonicalizes the batch for the bound account and chain', () => {
		const canonical = canonicalizeWalletSendCalls(parseRequest(createRequest({ id: '0x01', capabilities: { auxiliaryFunds: { optional: true } } }, [
			{ to: addressString(firstRecipient), value: '0x1', capabilities: { paymasterService: { optional: true } } },
			{ data: '0x6000' },
		])), account, chainId)
		if (!canonical.success) throw new Error(canonical.error.message)
		assert.deepEqual(serialize(WalletSendCalls, canonical.value), {
			method: 'wallet_sendCalls',
			params: [{
				version: '2.0.0',
				id: '0x01',
				from: addressString(account),
				chainId: '0x1',
				atomicRequired: false,
				calls: [
					{ to: addressString(firstRecipient), data: '0x', value: '0x1' },
					{ data: '0x6000', value: '0x0' },
				],
			}],
		})
		assert.deepEqual(getWalletSendCallsTransactionParams(canonical.value, account).map((transaction) => transaction.params[0]), [
			{ from: account, to: firstRecipient, value: 1n, data: new Uint8Array() },
			{ from: account, value: 0n, data: Uint8Array.from([0x60, 0x00]) },
		])
	})

	test('rejects batches the Interceptor cannot review or honour', () => {
		const getErrorCode = (request: unknown) => {
			const canonical = canonicalizeWalletSendCalls(parseRequest(request), account, chainId)
			return canonical.success ? undefined : canonical.error.code
		}
		assert.equal(getErrorCode(createRequest({ from: addressString(otherAccount) })), 4100)
		assert.equal(getErrorCode(createRequest({ chainId: '0x2105' })), 5710)
		assert.equal(getErrorCode(createRequest({}, [])), -32602)
		assert.equal(getErrorCode(createRequest({}, Array.from({ length: WALLET_SEND_CALLS_MAX_CALLS + 1 }, () => ({ to: addressString(firstRecipient) })))), 5740)
		assert.equal(getErrorCode(createRequest({ atomicRequired: true })), 5760)
		assert.equal(getErrorCode(createRequest({ capabilities: { paymasterService: { url: 'https://paymaster.example' } } })), 5700)
		assert.equal(getErrorCode(createRequest({}, [{ to: addressString(firstRecipient), capabilities: { permissions: { optional: false } } }])), 5700)
		assert.equal(getErrorCode(createRequest({ from: addressString(account) })), undefined)
	})

	test('only matches simulated transactions with the same calls in the same order', () => {
		const canonical = canonicalizeWalletSendCalls(parseRequest(createRequest()), account, chainId)
		if (!canonical.success) throw new Error(canonical.error.message)
		const toTransaction = (to: bigint, value: bigint, input: Uint8Array) => ({
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
			created: new Date(0),
			originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{}] as const },
			transactionIdentifier: to,
			success: true as const,
			transaction: { type: '1559' as const, from: account, chainId, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21_000n, to, value, input, accessList: [] },
		})
		const firstCall = toTransaction(firstRecipient, 1n, new Uint8Array())
		const secondCall = toTransaction(secondRecipient, 0n, Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb]))
		assert.equal(doWalletSendCallsMatchSimulatedTransactions(canonical.value, account, [firstCall, secondCall]), true)
		assert.equal(doWalletSendCallsMatchSimulatedTransactions(canonical.value, account, [secondCall, firstCall]), false)
		assert.equal(doWalletSendCallsMatchSimulatedTransactions(canonical.value, account, [firstCall]), false)
		assert.equal(doWalletSendCallsMatchSimulatedTransactions(canonical.value, account, [toTransaction(firstRecipient, 2n, new Uint8Array()), secondCall]), false)
		assert.equal(doWalletSendCallsMatchSimulatedTransactions(canonical.value, otherAccount, [firstCall, secondCall]), false)
	})

	test('signing mode refuses batches with the wording viem falls back on and knows no bundles, including for a Gnosis Safe signing account', () => {
		const sendCallsReply = getSigningModeWalletCallsReply(createInterceptedRequest(createRequest({ atomicRequired: true })))
		assert.ok(sendCallsReply?.type === 'result' && 'error' in sendCallsReply)
		assert.equal(sendCallsReply.error.code, 4200)
		// viem matches this MetaMask wording to fall back to eth_sendTransaction; it does not fall back on the code alone.
		assert.match(sendCallsReply.error.message, /does not exist \/ is not available/u)
		assert.match(sendCallsReply.error.message, /transient storage/u)
		for (const method of ['wallet_getCallsStatus', 'wallet_showCallsStatus']) {
			const reply = getSigningModeWalletCallsReply(createInterceptedRequest({ method, params: ['0x01'] }))
			assert.equal(reply?.type === 'result' && 'error' in reply ? reply.error.code : undefined, 5730)
		}
		assert.equal(getSigningModeWalletCallsReply(createInterceptedRequest({ method: 'wallet_getCapabilities', params: [addressString(account)] })), undefined)
		assert.equal(getSigningModeWalletCallsReply(createInterceptedRequest({ method: 'eth_sendTransaction', params: [{}] })), undefined)
	})

})
