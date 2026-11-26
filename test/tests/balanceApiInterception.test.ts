import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { installRpcReadInterception, type RpcRead } from '../../app/inpage/ts/rpcReadInterception.js'
import { SIMULATED_SITE_RPC_METHODS, resolveSiteBehavior } from '../../app/ts/utils/siteBehaviors.js'

const account = '0x1234567890123456789012345678901234567890'
const spender = '0x111111125421ca6dc452d289314280a0f8842a65'
const token = '0x2222222222222222222222222222222222222222'
const receivedToken = '0x3333333333333333333333333333333333333333'
const nativeToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const url = `https://proxy-app.1inch.com/v2.0/balance/v1.2/1/allowancesAndBalances/${ spender }/${ account }`
const context = { origin: 'https://arbitrary-app.example', chainId: '0x1', address: account, methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] }
const live = { [token]: { balance: '4', allowance: '0' }, [nativeToken]: { balance: '1', allowance: (2n ** 256n - 1n).toString() } }

function harness(rpc?: (request: RpcRead) => Promise<unknown>, response = () => Response.json(live)) {
	const reads: RpcRead[] = []
	const native: Request[] = []
	const windowObject = { location: { origin: context.origin }, fetch: async (input: RequestInfo | URL, init?: RequestInit) => { native.push(new Request(input, init)); return response() } }
	const original = windowObject.fetch
	const hook = installRpcReadInterception(windowObject, async (_chain, request) => {
		reads.push(request)
		if (rpc !== undefined) return await rpc(request)
		if (request.method === 'interceptor_getSimulationTokens') return [receivedToken]
		if (request.method === 'eth_getBalance') return '0x64'
		if (request.method === 'eth_call') return '0x20'
		throw new Error(`Unexpected simulated method: ${ request.method }`)
	})
	hook.setContext(context)
	return { windowObject, hook, reads, native, original }
}

test('the balance API overlays the selected account and includes tokens received only in the simulation', async () => {
	const h = harness()
	const response = await h.windowObject.fetch(url)
	assert.deepEqual(await response.json(), { [token]: { balance: '32', allowance: '32' }, [receivedToken]: { balance: '32', allowance: '32' }, [nativeToken]: { balance: '100', allowance: live[nativeToken].allowance } })
	assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
	assert.equal(response.headers.get('cache-control'), 'no-store')
	assert.equal(response.url, url)
	assert.equal(h.native.length, 1)
	assert.equal(h.reads.filter(({ method }) => method === 'eth_call').length, 4)
	assert.deepEqual(h.reads.find(({ method }) => method === 'eth_getBalance')?.params, [account, 'latest'])
	for (const request of h.reads.filter(({ method }) => method === 'eth_call')) {
		const call = request.params?.[0]
		assert.ok(typeof call === 'object' && call !== null && 'data' in call && typeof call.data === 'string')
		assert.ok(call.data.includes(account.slice(2)))
		if (call.data.startsWith('0xdd62ed3e')) assert.ok(call.data.endsWith(spender.slice(2).padStart(64, '0')))
	}
})

test('unrelated APIs, accounts, chains, methods and disabled sessions retain native balance responses', async () => {
	for (const resource of [url.replace('https:', 'http:'), url.replace('proxy-app.1inch.com', 'proxy-app.1inch.com.evil.test'), url.replace('/v1.2/1/', '/v1.2/137/'), url.replace(account, receivedToken), url.replace('allowancesAndBalances', 'balances')]) {
		const h = harness()
		assert.deepEqual(await (await h.windowObject.fetch(resource)).json(), live)
		assert.equal(h.reads.length, 0)
	}
	for (const value of [undefined, { ...context, address: undefined }]) {
		const h = harness()
		h.hook.setContext(value)
		assert.deepEqual(await (await h.windowObject.fetch(url)).json(), live)
		assert.equal(h.reads.length, 0)
	}
})

test('balance response schema drift and HTTP failures preserve native data, while simulation failures remain failures', async () => {
	for (const response of [() => new Response('not json'), () => Response.json({ unexpected: 'schema' }), () => new Response('denied', { status: 403 })]) {
		const h = harness(undefined, response)
		assert.equal((await h.windowObject.fetch(url)).headers.has('x-interceptor-simulation'), false)
		assert.equal(h.reads.length, 0)
	}
	const h = harness(async () => { throw new Error('simulation unavailable') })
	await assert.rejects(h.windowObject.fetch(url), /simulation unavailable/)
	assert.equal(h.native.length, 1)
})

test('balance overlays reject aborted reads and stale replies after account changes or revocation', async () => {
	for (const change of ['abort', 'revoke', 'account']) {
		let finish: ((value: unknown) => void) | undefined
		let entered: (() => void) | undefined
		const started = new Promise<void>((resolve) => { entered = resolve })
		const h = harness(async (request) => { if (request.method !== 'interceptor_getSimulationTokens') return '0x20'; entered?.(); return await new Promise((resolve) => { finish = resolve }) })
		const controller = new AbortController()
		const pending = h.windowObject.fetch(url, { signal: controller.signal })
		await started
		if (change === 'abort') controller.abort(new Error('cancelled'))
		else h.hook.setContext(change === 'account' ? { ...context, address: receivedToken } : undefined)
		finish?.([])
		await assert.rejects(pending, change === 'abort' ? /cancelled/ : /session changed/)
	}
})

for (const origin of ['https://swap.cow.fi', 'https://app.uniswap.org', 'https://unknown-app.example:8443', 'http://localhost:8123']) test(`standard RPC policy needs no website entry for ${ origin }`, () => {
	assert.deepEqual(resolveSiteBehavior(origin), { origin, rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] } })
})
