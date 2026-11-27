import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { installRpcReadInterception } from '../../app/inpage/ts/rpcReadInterception.js'
import { SIMULATED_SITE_RPC_METHODS } from '../../app/ts/utils/siteBehaviors.js'

const account = '0x1234567890123456789012345678901234567890'
const hash = '0x' + '12'.repeat(32)
const url = `https://entry-gateway.backend-prod.api.uniswap.org/swaps?chainId=1&txHashes=${ hash }`
const context = { origin: 'https://arbitrary-app.example', chainId: '0x1', address: account, methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] }
const live = { requestId: 'vendor-request', swaps: [{ status: 'NOT_FOUND', swapType: 'CLASSIC', txHash: hash }] }
const receipt = { from: account, transactionHash: hash, status: '0x1' }
function harness(result: unknown = receipt, body: unknown = live) {
	let reads = 0
	const windowObject = { location: { origin: context.origin }, fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body) }
	const hook = installRpcReadInterception(windowObject, async (_chain, request) => { reads++; assert.equal(request.method, 'eth_getTransactionReceipt'); assert.deepEqual(request.params, [hash]); return result })
	hook.setContext(context)
	return { windowObject, hook, reads: () => reads }
}

test('classic swap status comes from the selected account receipt, including failed simulations', async () => {
	for (const status of ['0x0', '0x1']) {
		const h = harness({ ...receipt, status })
		const response = await h.windowObject.fetch(url)
		assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
		assert.deepEqual(await response.json(), { ...live, swaps: [{ ...live.swaps[0], status: status === '0x1' ? 'SUCCESS' : 'FAILED' }] })
	}
})

test('swap status leaves other accounts, missing receipts, hash mismatches and unknown statuses unchanged', async () => {
	for (const result of [undefined, { ...receipt, from: '0x' + 'ab'.repeat(20) }, { ...receipt, transactionHash: '0x' + '34'.repeat(32) }, { ...receipt, status: '0x2' }]) {
		const h = harness(result === undefined ? {} : result)
		assert.deepEqual(await (await h.windowObject.fetch(url)).json(), live)
	}
})

test('swap status ignores other chains and APIs, signing mode, bridges, user operations and schema drift', async () => {
	for (const resource of [url.replace('chainId=1', 'chainId=137'), url + '&chainId=1', url.replace('/swaps?', '/orders?'), url.replace('https:', 'http:'), url.replace('api.uniswap.org', 'api.uniswap.org.evil.test')]) {
		const h = harness()
		assert.deepEqual(await (await h.windowObject.fetch(resource)).json(), live)
		assert.equal(h.reads(), 0)
	}
	for (const body of [{ unexpected: true }, { swaps: [{ ...live.swaps[0], swapType: 'BRIDGE' }] }, { swaps: [{ status: 'PENDING', userOpHash: hash }] }, { swaps: [{ ...live.swaps[0], status: 'SUCCESS' }] }]) {
		const h = harness(receipt, body)
		assert.deepEqual(await (await h.windowObject.fetch(url)).json(), body)
		assert.equal(h.reads(), 0)
	}
	const h = harness()
	h.hook.setContext(undefined)
	assert.deepEqual(await (await h.windowObject.fetch(url)).json(), live)
	assert.equal(h.reads(), 0)
})

test('swap status rejects stale replies and propagates simulation failures', async () => {
	for (const action of ['revoke', 'account', 'failure']) {
		let finish: ((value: unknown) => void) | undefined
		let entered: (() => void) | undefined
		const started = new Promise<void>((resolve) => { entered = resolve })
		const windowObject = { location: { origin: context.origin }, fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(live) }
		const hook = installRpcReadInterception(windowObject, async () => {
			if (action === 'failure') throw new Error('simulation unavailable')
			entered?.()
			return await new Promise((resolve) => { finish = resolve })
		})
		hook.setContext(context)
		const pending = windowObject.fetch(url)
		if (action !== 'failure') {
			await started
			hook.setContext(action === 'revoke' ? undefined : { ...context, address: '0x' + 'ab'.repeat(20) })
			finish?.(receipt)
		}
		await assert.rejects(pending, action === 'failure' ? /simulation unavailable/ : /session changed/)
	}
})
