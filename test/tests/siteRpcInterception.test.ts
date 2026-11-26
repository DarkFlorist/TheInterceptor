import * as assert from 'assert'
import { test } from 'bun:test'
import { installRpcReadInterception } from '../../app/inpage/ts/rpcReadInterception.js'
import { getSiteRpcExecution, prepareSiteRpcRequest } from '../../app/ts/background/siteRpcInterception.js'
import { SIMULATED_SITE_RPC_METHODS, SITE_BEHAVIOR_OVERRIDES, resolveSiteBehavior } from '../../app/ts/utils/siteBehaviors.js'
import { addressString, activeAddress, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const read = { jsonrpc: '2.0', id: 7, method: 'eth_call', params: [{ to: addressString(activeAddress), data: '0x' }, 'latest'] }
const behavior = resolveSiteBehavior('https://app.aave.com')
if (behavior === undefined) throw new Error('Missing configured site behavior')
const context = { origin: behavior.origin, chainId: '0x1', ...behavior.rpcReads }
const input = (body: unknown, signal?: AbortSignal) => new Request('https://rpc.example/ethereum', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'test-key' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })

function harness({ origin = 'https://app.aave.com', chainId = '0x1', probeGate = Promise.resolve(), probeError = new Map<string, Error>(), rpc = async (_chain: string, _request: unknown): Promise<unknown> => 'simulated' } = {}) {
	const nativeRequests: { url: string, body: unknown, authorization: string | null }[] = []
	const rpcRequests: unknown[] = []
	const windowObject = {
		location: { origin },
		fetch: async (resource: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(resource, init)
			const body: unknown = await request.json()
			nativeRequests.push({ url: request.url, body, authorization: request.headers.get('authorization') })
			const probe = typeof body === 'object' && body !== null && 'id' in body && body.id === 'interceptor-chain-probe'
			if (probe) await probeGate
			if (probe && probeError.has('error')) throw probeError.get('error')
			return new Response(JSON.stringify(probe ? { jsonrpc: '2.0', id: 'interceptor-chain-probe', result: chainId } : { jsonrpc: '2.0', id: 7, result: 'live' }))
		},
	}
	const original = windowObject.fetch
	const hook = installRpcReadInterception(windowObject, async (chain, request) => { rpcRequests.push({ chain, request }); return await rpc(chain, request) })
	return { windowObject, original, hook, nativeRequests, rpcRequests }
}

test('Aave routes single reads and read-only batches through simulation, preserving IDs, params and fetch response metadata', async () => {
	const h = harness()
	h.hook.setContext(context)
	const response = await h.windowObject.fetch(input(read))
	assert.equal(response.status, 200)
	assert.equal(response.url, 'https://rpc.example/ethereum')
	assert.equal(response.headers.get('content-type'), 'application/json')
	assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 7, result: 'simulated' })
	assert.deepEqual(h.rpcRequests, [{ chain: '0x1', request: read }])
	const batch = [{ ...read, id: 'request' }, { jsonrpc: '2.0', id: null, method: 'eth_blockNumber' }]
	assert.deepEqual(await (await h.windowObject.fetch(input(batch))).json(), batch.map(({ id }) => ({ jsonrpc: '2.0', id, result: 'simulated' })))
	assert.equal(h.nativeRequests.length, 1, 'only a chain probe reaches the endpoint; repeated requests reuse its chain identification')
	assert.equal(h.nativeRequests[0]?.authorization, 'test-key')
	h.hook.dispose()
	assert.equal(h.windowObject.fetch, h.original)
})

test('Aave interception leaves disabled sessions, other origins, other chains, mutations and malformed or mixed batches on their native transport', async () => {
	for (const origin of ['https://app.aave.com', 'https://other.example']) {
		const h = harness({ origin })
		await h.windowObject.fetch(input(read))
		assert.equal(h.rpcRequests.length, 0)
		assert.equal(h.nativeRequests.length, 1)
		h.hook.dispose()
	}
	const otherChain = harness({ chainId: '0x89' })
	otherChain.hook.setContext(context)
	assert.equal((await (await otherChain.windowObject.fetch(input(read))).json()).result, 'live')
	assert.equal(otherChain.rpcRequests.length, 0)
	assert.equal(otherChain.nativeRequests.length, 2)
	for (const body of [{ ...read, method: 'eth_sendRawTransaction' }, { method: 'eth_call', params: [] }, [read, { ...read, method: 'personal_sign', id: 2 }], [read, read], [], { ...read, id: undefined }]) {
		const h = harness()
		h.hook.setContext(context)
		await h.windowObject.fetch(input(body))
		assert.equal(h.nativeRequests.length, 1)
		assert.equal(h.rpcRequests.length, 0)
	}
})

test('Aave RPC errors are returned without falling back to live state, while unexpected errors propagate', async () => {
	const h = harness({ rpc: async () => { throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x1234' }) } })
	h.hook.setContext(context)
	assert.deepEqual(await (await h.windowObject.fetch(input(read))).json(), { jsonrpc: '2.0', id: 7, error: { code: 3, message: 'execution reverted', data: '0x1234' } })
	assert.equal(h.nativeRequests.length, 1)
	const broken = harness({ rpc: async () => { throw new Error('unexpected bridge failure') } })
	broken.hook.setContext(context)
	await assert.rejects(broken.windowObject.fetch(input(read)), /unexpected bridge failure/)
	assert.equal(broken.nativeRequests.length, 1)
})

test('Aave fetch aborts while a simulated read is pending and drops replies from revoked sessions', async () => {
	for (const abort of [true, false]) {
		let finish: ((value: unknown) => void) | undefined
		let entered: (() => void) | undefined
		const started = new Promise<void>((resolve) => { entered = resolve })
		const h = harness({ rpc: async () => { entered?.(); return await new Promise((resolve) => { finish = resolve }) } })
		h.hook.setContext(context)
		const controller = new AbortController()
		const pending = h.windowObject.fetch(input(read, controller.signal))
		await started
		if (abort) controller.abort(new Error('HTTP request cancelled'))
		else h.hook.setContext(undefined)
		finish?.('stale simulated state')
		await assert.rejects(pending, abort ? /HTTP request cancelled/ : /session changed/)
	}
})

test('background Aave admission enforces website, simulation mode, chain and read-only schemas independently of the fetch hook', () => {
	const wrap = (rpc: unknown = read, chainId = '0x1') => ({ method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, params: [{ chainId, request: rpc }] })
	const rpcExecution = getSiteRpcExecution(wrap(), 'https://app.aave.com', true, 1n)
	assert.equal(rpcExecution?.kind, 'rpc')
	assert.equal(rpcExecution?.kind === 'rpc' ? rpcExecution.request.method : undefined, 'eth_call')
	for (const method of ['interceptor_getSimulationTokens', 'interceptor_getSimulationTokenMetadata']) {
		const tokenExecution = getSiteRpcExecution(wrap({ method }), 'https://app.aave.com', true, 1n)
		assert.ok(tokenExecution?.kind === 'tokens')
		assert.equal(tokenExecution.includeTokenMetadata, method === 'interceptor_getSimulationTokenMetadata')
		assert.equal(tokenExecution.request.method, 'site_rpc_request')
	}
	for (const [request, origin, mode, chain] of [[wrap(), 'other.example', true, 1n], [wrap(), 'chrome-extension://extension-id', true, 1n], [wrap(), 'https://app.aave.com', false, 1n], [wrap(), 'https://app.aave.com', true, 137n], [wrap({ ...read, method: 'eth_sendTransaction' }), 'https://app.aave.com', true, 1n], [wrap({ ...read, params: 'invalid' }), 'https://app.aave.com', true, 1n]] as const) {
		assert.equal(getSiteRpcExecution(request, origin, mode, chain)?.kind, 'rejected')
	}
})


test('Aave same-origin rpc-proxy reads use their declared chain and generated response ID without a chain probe', async () => {
	const h = harness()
	h.hook.setContext(context)
	const proxyInput = (chainId: unknown, method = 'eth_call', url = 'https://app.aave.com/api/rpc-proxy/') => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId, method, params: read.params }) })
	const response = await h.windowObject.fetch(proxyInput(1))
	const result = await response.json()
	assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
	assert.equal(result.jsonrpc, '2.0')
	assert.equal(typeof result.id, 'number')
	assert.equal(result.result, 'simulated')
	assert.equal(h.nativeRequests.length, 0)
	assert.equal(h.rpcRequests.length, 1)
	for (const request of [proxyInput(137), proxyInput('invalid'), proxyInput(1, 'eth_sendRawTransaction'), proxyInput(1, 'eth_call', 'https://other.example/api/rpc-proxy/')]) await h.windowObject.fetch(request)
	assert.equal(h.rpcRequests.length, 1, 'other-chain, malformed, mutating and other-origin proxy requests stay untouched')
	assert.equal(h.nativeRequests.length, 4)
})


test('Aave preserves native transport on identified fetch probe network failures and propagates unexpected errors', async () => {
	for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
		const h = harness({ probeError: new Map([['error', new TypeError(message)]]) })
		h.hook.setContext(context)
		assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'live')
		assert.equal(h.nativeRequests.length, 2)
		assert.equal(h.rpcRequests.length, 0)
	}
	const h = harness({ probeError: new Map([['error', new TypeError('invalid fetch configuration')]]) })
	h.hook.setContext(context)
	await assert.rejects(h.windowObject.fetch(input(read)), /invalid fetch configuration/)
	assert.equal(h.nativeRequests.length, 1)
})


test('Aave shared in-flight probe network failures preserve every caller native request', async () => {
	for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
		let finishProbe: (() => void) | undefined
		const probeGate = new Promise<void>((resolve) => { finishProbe = resolve })
		const h = harness({ probeGate, probeError: new Map([['error', new TypeError(message)]]) })
		h.hook.setContext(context)
		const first = h.windowObject.fetch(input(read))
		const second = h.windowObject.fetch(input({ ...read, id: 8 }))
		await Bun.sleep(10)
		assert.equal(h.nativeRequests.length, 1, 'both requests share the blocked identification probe')
		finishProbe?.()
		for (const response of await Promise.all([first, second])) assert.equal((await response.json()).result, 'live')
		assert.equal(h.nativeRequests.length, 3, 'one failed probe and both original native requests')
		assert.equal(h.rpcRequests.length, 0)
	}
})


test('site RPC transport activates only from matching published context and supports another configured origin without a dapp branch', async () => {
	const h = harness({ origin: 'https://second.example' })
	assert.equal(h.windowObject.fetch, h.original)
	h.hook.setContext(context)
	assert.equal(h.windowObject.fetch, h.original, 'context for another origin cannot provision this page')
	const second = { origin: 'https://second.example', rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: ['/chain-rpc'] } }
	assert.equal(resolveSiteBehavior(second.origin, [second]), second)
	h.hook.setContext({ origin: second.origin, chainId: '0x1', ...second.rpcReads })
	const response = await h.windowObject.fetch(new Request('https://second.example/chain-rpc', { method: 'POST', body: JSON.stringify({ chainId: 1, method: 'eth_call', params: read.params }) }))
	assert.equal((await response.json()).result, 'simulated')
	assert.equal(h.nativeRequests.length, 0)
	h.hook.setContext(undefined)
	assert.equal(h.windowObject.fetch, h.original)
})


test('policy publication and admission reuse the captured full frame origin, ignoring later port URL changes', async () => {
	const { getConnectionOrigin } = await import('../../app/ts/background/siteBehaviorContext.js')
	const { getFrameOrigins } = await import('../../app/ts/utils/requests.js')
	const { createPort, installBrowserMock, loadModules } = await import('./backgroundEthAccountsTestHarness.js')
	installBrowserMock()
	const { websiteSocketToString } = await loadModules()
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(1, undefined, 0)
	for (const url of ['https://app.aave.com/path', 'http://app.aave.com/path', 'https://app.aave.com:8443/path', 'https://app.aave.com.evil.test/path']) {
		const origins = getFrameOrigins(url)
		const connections = new Map([[1, { connections: { [websiteSocketToString(socket)]: { port, socket, ...origins, approved: true, wantsToConnect: true } } }]])
		Object.assign(port.sender, { url: 'https://unrelated.example/' })
		const origin = getConnectionOrigin(connections, socket)
		assert.equal(origin, origins.requestOrigin)
		assert.equal(origin !== undefined && resolveSiteBehavior(origin) !== undefined, true)
		assert.deepEqual(resolveSiteBehavior(origins.requestOrigin ?? '')?.rpcReads.chainRoutedProxyPaths, url === 'https://app.aave.com/path' ? ['/api/rpc-proxy'] : [])
	}
	const missingOrigin = new Map([[1, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'app.aave.com', approved: true, wantsToConnect: true } } }]])
	assert.equal(getConnectionOrigin(missingOrigin, socket), undefined)
})


test('behavior overrides use unique canonical origins and normalized same-origin proxy paths', () => {
	assert.equal(new Set(SITE_BEHAVIOR_OVERRIDES.map((entry) => entry.origin)).size, SITE_BEHAVIOR_OVERRIDES.length)
	for (const entry of SITE_BEHAVIOR_OVERRIDES) {
		const origin = new URL(entry.origin)
		assert.equal(origin.origin, entry.origin)
		assert.ok(['https:', 'http:'].includes(origin.protocol))
		for (const path of entry.rpcReads.chainRoutedProxyPaths) {
			const proxy = new URL(path, origin)
			assert.equal(proxy.origin, entry.origin)
			assert.equal(proxy.pathname, path)
			assert.equal(path.endsWith('/'), false)
		}
	}
})


test('site extension lifecycle preserves page fetch instrumentation across activation, revocation and reactivation', async () => {
	const { createSiteBehaviorExtensions } = await import('../../app/inpage/ts/siteBehaviorExtensions.js')
	const h = harness()
	const native = h.windowObject.fetch
	let instrumented = 0
	const instrumentation: typeof fetch = async (input, init) => { instrumented++; return await native(input, init) }
	const manager = createSiteBehaviorExtensions(h.windowObject, async () => 'simulated')
	h.windowObject.fetch = instrumentation
	manager.setContext({ rpcInterception: context })
	const firstHook = h.windowObject.fetch
	let pageCalls = 0
	const laterInstrumentation: typeof fetch = async (input, init) => { pageCalls++; return await firstHook(input, init) }
	h.windowObject.fetch = laterInstrumentation
	assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'simulated')
	manager.setContext({})
	assert.equal(h.windowObject.fetch, laterInstrumentation)
	assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'live')
	manager.setContext({ rpcInterception: context })
	assert.equal(h.windowObject.fetch, laterInstrumentation, 'reactivation must preserve the existing page wrapper instead of capturing it below a second hook')
	assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'simulated', 'reactivation must not create a cycle through a page wrapper retaining the old hook')
	assert.equal(instrumented, 3)
	assert.equal(pageCalls, 3, 'each application read crosses the page wrapper exactly once; internal chain probes do not re-enter it')
	for (const inactive of [{}, { rpcInterception: { ...context, origin: 'https://other.example' } }]) {
		manager.setContext(inactive)
		assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'live')
		manager.setContext({ rpcInterception: context })
		assert.equal(h.windowObject.fetch, laterInstrumentation)
		assert.equal((await (await firstHook(input(read))).json()).result, 'simulated', 'retained references regain the same live context')
	}
	assert.equal(pageCalls, 5)
	manager.dispose()
	assert.equal((await (await firstHook(input(read))).json()).result, 'live', 'final teardown disables retained references')
	assert.equal(h.windowObject.fetch, laterInstrumentation)
})


test('Lido balance batches containing fee history use the shared simulation transport and universal policy admission', async () => {
	const lido = resolveSiteBehavior('https://stake.lido.fi')
	assert.ok(lido)
	const h = harness({ origin: lido.origin })
	h.hook.setContext({ origin: lido.origin, chainId: '0x1', ...lido.rpcReads })
	const balances = [
		{ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addressString(activeAddress), 'latest'] },
		{ jsonrpc: '2.0', id: 3, method: 'eth_feeHistory', params: ['0x5', 'pending', [25]] },
		{ ...read, id: 2, params: [{ to: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', data: '0x70a08231' + addressString(activeAddress).slice(2).padStart(64, '0') }, 'latest'] },
	]
	const response = await h.windowObject.fetch(input(balances))
	assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
	assert.deepEqual(await response.json(), balances.map(({ id }) => ({ jsonrpc: '2.0', id, result: 'simulated' })))
	assert.equal(h.nativeRequests.length, 1, 'only endpoint chain identification uses the network')
	for (const request of balances) {
		const envelope = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, params: [{ chainId: '0x1', request }] }
		const execution = getSiteRpcExecution(envelope, lido.origin, true, 1n)
		assert.ok(execution?.kind === 'rpc')
		assert.equal(execution.request.method, request.method)
		for (const origin of ['file://', 'chrome-extension://extension-id', 'https://stake.lido.fi/path']) assert.equal(getSiteRpcExecution(envelope, origin, true, 1n)?.kind, 'rejected')
		assert.equal(getSiteRpcExecution(envelope, lido.origin, false, 1n)?.kind, 'rejected')
	}
	h.hook.setContext(undefined)
	assert.equal(h.windowObject.fetch, h.original)
})


test('hosted SDK clients retaining fetch before context publication follow activation and revocation', async () => {
	const { createSiteBehaviorExtensions } = await import('../../app/inpage/ts/siteBehaviorExtensions.js')
	const h = harness()
	const native = h.windowObject.fetch
	const manager = createSiteBehaviorExtensions(h.windowObject, async () => 'simulated', true)
	const retained = h.windowObject.fetch
	assert.notEqual(retained, native)
	assert.equal((await (await retained(input(read))).json()).result, 'live')
	manager.setContext({})
	assert.equal(h.windowObject.fetch, retained, 'a provisional inactive context keeps the early passthrough reference capturable')
	const wrapper: typeof fetch = async (request, init) => await retained(request, init)
	h.windowObject.fetch = wrapper
	manager.setContext({ rpcInterception: context })
	assert.equal(h.windowObject.fetch, wrapper, 'activation preserves later page instrumentation')
	assert.equal((await (await retained(input(read))).json()).result, 'simulated')
	manager.setContext({})
	assert.equal((await (await wrapper(input(read))).json()).result, 'live')
	manager.setContext({ rpcInterception: context })
	assert.equal((await (await wrapper(input(read))).json()).result, 'simulated', 'reusing a captured hook must not recurse or stay disabled')
	manager.dispose()
	assert.equal((await (await retained(input(read))).json()).result, 'live')
})

test('hosted startup reads wait for the first simulation context instead of caching live balances', async () => {
	const h = harness()
	const hook = installRpcReadInterception(h.windowObject, async () => 'simulated', true)
	const pending = h.windowObject.fetch(input(read))
	await new Promise((resolve) => setTimeout(resolve, 10))
	assert.equal(h.nativeRequests.length, 0)
	hook.setContext(context)
	assert.equal((await (await pending).json()).result, 'simulated')
	hook.dispose()
})

test('signing context and disposal release hosted startup reads to the original transport', async () => {
	for (const action of ['signing', 'dispose']) {
		const h = harness()
		const hook = installRpcReadInterception(h.windowObject, async () => 'simulated', true)
		const pending = h.windowObject.fetch(input(read))
		if (action === 'signing') hook.setContext(undefined)
		else hook.dispose()
		assert.equal((await (await pending).json()).result, 'live')
	}
})

test('a failed startup chain probe is retried when gateway authorization becomes ready', async () => {
	for (const failure of [() => new Response('session not ready', { status: 401 }), () => new Response('busy', { status: 429 }), () => Response.json({ malformed: true })]) {
		let probes = 0
		let nativeReads = 0
		const windowObject = { location: { origin: context.origin }, fetch: async (resource: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(resource, init)
			const body = await request.json()
			if (body.method === 'eth_chainId') {
				probes++
				return probes === 1 ? failure() : Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1' })
			}
			nativeReads++
			return Response.json({ jsonrpc: '2.0', id: body.id, result: 'live' })
		} }
		const hook = installRpcReadInterception(windowObject, async () => 'simulated')
		hook.setContext(context)
		assert.equal((await (await windowObject.fetch(input(read))).json()).result, 'live')
		assert.equal((await (await windowObject.fetch(input(read))).json()).result, 'simulated')
		assert.equal(probes, 2)
		assert.equal(nativeReads, 1)
		hook.dispose()
	}
})


test('unlisted HTTP origins use the universal policy and overrides customize transport without granting access', () => {
	const origin = 'https://unlisted.example'
	const defaults = { origin, rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] } }
	assert.deepEqual(resolveSiteBehavior(origin, []), defaults)
	assert.deepEqual(resolveSiteBehavior(origin), defaults)
	const override = { origin, rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: ['/custom-rpc'] } }
	assert.equal(resolveSiteBehavior(origin, [override]), override)
	assert.deepEqual(resolveSiteBehavior(origin, []), defaults, 'removing an override restores the standard transport rather than disabling the origin')
	for (const invalid of ['file://', 'chrome-extension://id', origin + '/path', 'invalid']) assert.equal(resolveSiteBehavior(invalid), undefined)
})


test('a disabled site admission returns a terminal error reply without throwing or running simulation', async () => {
	const { installBrowserMock, loadModules, createEthereumWithGetBlockCounter } = await import('./backgroundEthAccountsTestHarness.js')
	const { createGnosisSafeAddressBookEntry } = await import('./confirmTransactionTestHarness.js')
	installBrowserMock()
	const { getSettings } = await loadModules()
	const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
	const request = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, params: [{ chainId: '0x1', request: read }] }
	const result = await prepareSiteRpcRequest(ethereum, new Map(), request, await getSettings(), { activeAddress: createGnosisSafeAddressBookEntry(), accessSocket: uniqueRequestIdentifier.requestSocket, accessOrigin: 'https://app.aave.com', requireAddressAccess: true, isCurrent: async () => true })
	assert.deepEqual(result, { kind: 'reply', reply: { type: 'result', method: 'site_rpc_request', uniqueRequestIdentifier, error: { code: -32602, message: 'Site RPC interception is not enabled for this connection.' } } })
})


test('final hook disposal rejects late context publications and keeps retained references native', async () => {
	const h = harness()
	h.hook.setContext(context)
	const retained = h.windowObject.fetch
	h.hook.dispose()
	assert.equal(h.hook.setContext(context), false)
	assert.equal(h.windowObject.fetch, h.original)
	assert.equal((await (await retained(input(read))).json()).result, 'live')
	assert.equal(h.rpcRequests.length, 0)
})

test('a page reassigning a retired hook does not transfer ownership of its fetch slot back to Interceptor', async () => {
	const h = harness()
	h.hook.setContext(context)
	const retained = h.windowObject.fetch
	h.hook.setContext(undefined)
	assert.equal(h.windowObject.fetch, h.original)
	h.windowObject.fetch = retained
	h.hook.setContext(context)
	assert.equal((await (await h.windowObject.fetch(input(read))).json()).result, 'simulated')
	h.hook.dispose()
	assert.equal(h.windowObject.fetch, retained, 'disposal must preserve the page-owned assignment even when it uses our previous function')
	assert.equal((await (await retained(input(read))).json()).result, 'live')
})


test('browser-like network errors from simulated reads never fall back to live transport', async () => {
	for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
		const failure = new TypeError(message)
		const h = harness({ rpc: async () => { throw failure } })
		h.hook.setContext(context)
		await assert.rejects(h.windowObject.fetch(input(read)), (error: unknown) => error === failure)
		assert.equal(h.nativeRequests.length, 1, 'only the successful identification probe reached native transport')
	}
})
