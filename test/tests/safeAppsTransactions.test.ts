import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSafeAppsRequestCommand } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const safeAddress = '0x1111111111111111111111111111111111111111'
const hash = `0x${ 'ab'.repeat(32) }`
const transactionId = `multisig_${ safeAddress }_${ hash }`
const network = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
const unusedSafeState = async (): Promise<never> => { throw new Error('Indexed lookup does not need an RPC owner or nonce lookup') }
const requestTransaction = (params: unknown = { safeTxHash: hash }) => getSafeAppsRequestCommand({ method: 'getTxBySafeTxHash', params }, 'app.example', BigInt(safeAddress), network, unusedSafeState)
const details = {
	safeAddress, txId: transactionId, txStatus: 'AWAITING_CONFIRMATIONS',
	txInfo: { type: 'Custom', to: { value: safeAddress }, dataSize: '0', value: '0', isCancellation: false },
	txData: { hexData: '0x', value: '0', to: { value: safeAddress }, operation: 0 },
	detailedExecutionInfo: { type: 'MULTISIG', safeTxHash: hash, nonce: 4, confirmationsRequired: 2, confirmations: [], signers: [], submittedAt: 1700000000000, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: safeAddress, refundReceiver: { value: safeAddress }, trusted: true, proposer: null, proposedByDelegate: null },
}

describe('Safe Apps transaction lookup', () => {
	test('uses the selected Safe and chain and preserves pending and executed SDK details', async () => {
		const originalFetch = globalThis.fetch
		const urls: string[] = []
		let response = details
		globalThis.fetch = async (input, init) => {
			urls.push(String(input))
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.equal(init?.method, undefined)
			assert.ok(init?.signal)
			return Response.json(response)
		}
		try {
			assert.deepEqual(await requestTransaction({ safeTxHash: hash.toUpperCase(), safeAddress: 'other-safe', chainId: 137 }), { kind: 'result', value: details })
			const executed = { ...details, txStatus: 'SUCCESS', txHash: `0x${ 'cd'.repeat(32) }`, executedAt: 1700000001000 }
			response = executed
			assert.deepEqual(await requestTransaction(), { kind: 'result', value: executed })
			assert.deepEqual(urls, Array(2).fill(`https://safe-client.safe.global/v1/chains/1/transactions/${ transactionId }`))
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('rejects invalid hashes before making a service request', async () => {
		const originalFetch = globalThis.fetch
		let calls = 0
		globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch') }
		try {
			for (const params of [null, {}, [], hash, { safeTxHash: '' }, { safeTxHash: '0x123' }, { safeTxHash: 1 }, { safeTxHash: `0x${ 'gg'.repeat(32) }` }, { safeTxHash: '../transactions' }]) {
				await assert.rejects(requestTransaction(params), /32-byte Safe transaction hash/)
			}
			assert.equal(calls, 0)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('rejects malformed details and responses for another Safe or transaction', async () => {
		const originalFetch = globalThis.fetch
		try {
			for (const result of [{}, { ...details, safeAddress: '0x2222222222222222222222222222222222222222' }, { ...details, txId: 'wrong-id' }, { ...details, detailedExecutionInfo: { ...details.detailedExecutionInfo, safeTxHash: `0x${ 'cd'.repeat(32) }` } }, { ...details, txInfo: null }]) {
				globalThis.fetch = async () => Response.json(result)
				await assert.rejects(requestTransaction(), /invalid or mismatched transaction details/)
			}
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('reports missing transactions and service errors explicitly', async () => {
		const originalFetch = globalThis.fetch
		try {
			globalThis.fetch = async () => new Response(undefined, { status: 404 })
			await assert.rejects(requestTransaction(), (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32000 && /not found for the selected Safe and network/.test(error.message))
			globalThis.fetch = async () => new Response(undefined, { status: 503 })
			await assert.rejects(requestTransaction(), /transaction service.*HTTP 503/)
			globalThis.fetch = async () => new Response('bad json')
			await assert.rejects(requestTransaction(), /transaction service returned invalid JSON/)
			globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
			await assert.rejects(requestTransaction(), /transaction service could not be reached/)
			globalThis.fetch = async () => { throw new Error('Unexpected programmer error') }
			await assert.rejects(requestTransaction(), /Unexpected programmer error/)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
