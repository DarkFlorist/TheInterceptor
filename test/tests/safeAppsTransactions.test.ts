import { fetchSafeAppsTransaction } from '../../app/ts/background/safeAppsTransactions.js'
import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import { getSafeAppsRequestCommand } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { replaceGlobal } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'

type FetchResponder = (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>
const rejectUnexpectedFetch: FetchResponder = async () => { throw new Error('Unexpected fetch') }

const safeAddress = '0x1111111111111111111111111111111111111111'
const hash = `0x${ 'ab'.repeat(32) }`
const transactionId = `multisig_${ safeAddress }_${ hash }`
const network = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
const unusedSafeState = async (): Promise<never> => { throw new Error('Indexed lookup does not need an RPC owner or nonce lookup') }
const requestTransaction = (params: unknown = { safeTxHash: hash }) => getSafeAppsRequestCommand({ method: 'getTxBySafeTxHash', params }, 'app.example', BigInt(safeAddress), network, unusedSafeState, { getTransaction: async (safeTxHash) => await fetchSafeAppsTransaction(network.chainId, BigInt(safeAddress), safeTxHash) })
// Mirrors the Safe client gateway response, which reports an absent proposer and delegate as JSON null.
const details = {
	safeAddress, txId: transactionId, txStatus: 'AWAITING_CONFIRMATIONS',
	txInfo: { type: 'Custom', to: { value: safeAddress }, dataSize: '0', value: '0', isCancellation: false },
	txData: { hexData: '0x', value: '0', to: { value: safeAddress }, operation: 0 },
	detailedExecutionInfo: { type: 'MULTISIG', safeTxHash: hash, nonce: 4, confirmationsRequired: 2, confirmations: [], signers: [], submittedAt: 1700000000000, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: safeAddress, refundReceiver: { value: safeAddress }, trusted: true, proposer: null, proposedByDelegate: null },
}

describe('Safe Apps transaction lookup', () => {
	// Every test installs a fetch global that forwards to fetchResponder, swaps fetchResponder to script the transaction service, and restores fetch afterwards.
	let fetchResponder = rejectUnexpectedFetch
	const { restoreAfterTest } = createPerTestRestorer()
	beforeEach(() => {
		fetchResponder = rejectUnexpectedFetch
		restoreAfterTest(replaceGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => await fetchResponder(input, init)))
	})

	test('uses the selected Safe and chain and preserves pending and executed SDK details', async () => {
		const urls: string[] = []
		let response = details
		fetchResponder = async (input, init) => {
			urls.push(String(input))
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.equal(init?.method, undefined)
			assert.ok(init?.signal)
			return Response.json(response)
		}
		assert.deepEqual(await requestTransaction({ safeTxHash: hash.toUpperCase(), safeAddress: 'other-safe', chainId: 137 }), { kind: 'result', value: details })
		const executed = { ...details, txStatus: 'SUCCESS', txHash: `0x${ 'cd'.repeat(32) }`, executedAt: 1700000001000 }
		response = executed
		assert.deepEqual(await requestTransaction(), { kind: 'result', value: executed })
		assert.deepEqual(urls, Array(2).fill(`https://safe-client.safe.global/v1/chains/1/transactions/${ transactionId }`))
	})

	test('rejects invalid hashes before making a service request', async () => {
		let calls = 0
		fetchResponder = async () => { calls++; throw new Error('Unexpected fetch') }
		// Safe Apps send untrusted params, so a JSON null is one of the malformed inputs.
		for (const params of [null, {}, [], hash, { safeTxHash: '' }, { safeTxHash: '0x123' }, { safeTxHash: 1 }, { safeTxHash: `0x${ 'gg'.repeat(32) }` }, { safeTxHash: '../transactions' }]) {
			await assert.rejects(requestTransaction(params), /32-byte Safe transaction hash/)
		}
		assert.equal(calls, 0)
	})

	test('rejects malformed details and responses for another Safe or transaction', async () => {
		for (const result of [{}, { ...details, safeAddress: '0x2222222222222222222222222222222222222222' }, { ...details, txId: 'wrong-id' }, { ...details, detailedExecutionInfo: { ...details.detailedExecutionInfo, safeTxHash: `0x${ 'cd'.repeat(32) }` } }, { ...details, txInfo: null }]) {
			fetchResponder = async () => Response.json(result)
			await assert.rejects(requestTransaction(), /invalid or mismatched transaction details/)
		}
	})

	test('reports missing transactions and service errors explicitly', async () => {
		fetchResponder = async () => new Response(undefined, { status: 404 })
		await assert.rejects(requestTransaction(), (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32000 && /not found for the selected Safe and network/.test(error.message))
		fetchResponder = async () => new Response(undefined, { status: 503 })
		await assert.rejects(requestTransaction(), /transaction service.*HTTP 503/)
		fetchResponder = async () => new Response('bad json')
		await assert.rejects(requestTransaction(), /transaction service returned invalid JSON/)
		fetchResponder = async () => { throw new TypeError('Failed to fetch') }
		await assert.rejects(requestTransaction(), /transaction service could not be reached/)
		fetchResponder = async () => { throw new Error('Unexpected programmer error') }
		await assert.rejects(requestTransaction(), /Unexpected programmer error/)
	})
})
