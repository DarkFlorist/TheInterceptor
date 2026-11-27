import * as assert from 'assert'
import { test } from 'bun:test'
import { prepareSiteHttpApiInterception, shouldWaitForSiteHttpContext } from '../../app/inpage/ts/siteHttpApiAdapters.js'
import { installRpcReadInterception } from '../../app/inpage/ts/rpcReadInterception.js'
import { SITE_HTTP_API_ROUTES, SIMULATION_NATIVE_TOKEN_ADDRESS } from '../../app/shared/ts/siteBehaviorPolicy.js'

const account = '0x1234567890123456789012345678901234567890'
const context = { chainId: '0x1', address: account }
const balance = `https://proxy-app.1inch.com/v2.0/balance/v1.2/1/allowancesAndBalances/${ account }/${ account }`
const swaps = 'https://entry-gateway.backend-prod.api.uniswap.org/swaps?chainId=1'
const portfolio = 'https://entry-gateway.backend-prod.api.uniswap.org/data.v1.DataApiService/GetPortfolio'
const payload = { walletAccount: { platformAddresses: [{ address: account }] }, chainIds: [1] }
const portfolioRequest = (body: unknown = payload) => new Request(portfolio, { method: 'POST', body: JSON.stringify(body) })

test('HTTP adapter dispatch is exclusive and independent of registry ordering', async () => {
	for (const request of [new Request(balance), new Request(swaps), portfolioRequest()]) {
		for (const routes of [SITE_HTTP_API_ROUTES, [...SITE_HTTP_API_ROUTES].reverse()]) {
			const apply = await prepareSiteHttpApiInterception(request.clone(), context, routes)
			assert.ok(apply)
			const sent: string[] = []
			const response = new Response('temporarily unavailable', { status: 503 })
			assert.strictEqual(await apply(async (request) => { sent.push(request.url); return response }, async () => { throw new Error('HTTP failures must not invoke simulation') }), response)
			assert.deepEqual(sent, [request.url], 'exactly one selected adapter owns the request and response')
		}
	}
	const route = SITE_HTTP_API_ROUTES[0]
	assert.ok(route)
	await assert.rejects(prepareSiteHttpApiInterception(new Request(balance), context, [route, route]), /Ambiguous site HTTP API interception routes/)
})

test('adapter preparation performs no HTTP or RPC on route, account, chain and body mismatches', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { throw new Error('Preparation must never send an HTTP request') }
	try {
		for (const request of [new Request('https://unmatched.example/swaps'), new Request(balance, { method: 'POST' }), new Request(balance.replace('/v1.2/1/', '/v1.2/137/')), new Request(balance.slice(0, -account.length) + '0x' + 'ab'.repeat(20)), new Request(swaps.replace('chainId=1', 'chainId=137')), portfolioRequest({ ...payload, chainIds: [137] }), portfolioRequest({ ...payload, modifier: { address: '0x' + 'ab'.repeat(20) } }), portfolioRequest({ invalid: 'schema' })]) {
			assert.equal(await prepareSiteHttpApiInterception(request, context), undefined, request.url)
		}
		assert.equal(await prepareSiteHttpApiInterception(new Request(balance), { chainId: '0x1' }), undefined)
	} finally { globalThis.fetch = originalFetch }
})

test('document-start API capture consults the same canonical routes as adapter dispatch', () => {
	assert.equal(shouldWaitForSiteHttpContext('GET', balance), true)
	assert.equal(shouldWaitForSiteHttpContext('GET', swaps), true)
	assert.equal(shouldWaitForSiteHttpContext('POST', portfolio), true)
	assert.equal(shouldWaitForSiteHttpContext('GET', 'https://proxy-app.1inch.com/unrelated'), false)
	assert.equal(shouldWaitForSiteHttpContext('GET', 'https://unmatched.example/swaps'), false)
	assert.equal(shouldWaitForSiteHttpContext('POST', 'https://rpc.example'), true)
})


test('document-start capture preserves relative GET requests before context arrives', async () => {
	const sent: (RequestInfo | URL)[] = []
	const windowObject = { location: { origin: 'https://app.aave.com' }, fetch: async (input: RequestInfo | URL) => { sent.push(input); return new Response('native asset') } }
	const hook = installRpcReadInterception(windowObject, async () => { throw new Error('An inactive session cannot simulate') }, true)
	try {
		const pending = windowObject.fetch('/assets/config.json')
		assert.deepEqual(sent, ['/assets/config.json'], 'relative assets immediately retain their original native transport argument')
		assert.equal(await (await pending).text(), 'native asset')
	} finally { hook.dispose() }
})


test('a second route using the same balance adapter receives the selected typed route parameters', async () => {
	const original = SITE_HTTP_API_ROUTES.find((route) => route.adapter === 'balance')
	assert.ok(original)
	const alternative = { ...original, path: /^\/(v3\.0)\/balance\/v2\.0\/(?<chainId>[1-9][0-9]{0,77})\/allowancesAndBalances\/(?<spender>0x[0-9a-f]{40})\/(?<account>0x[0-9a-f]{40})\/?$/i }
	const request = new Request(balance.replace('/v2.0/balance/v1.2/', '/v3.0/balance/v2.0/'))
	for (const routes of [[original, alternative], [alternative, original]]) {
		const apply = await prepareSiteHttpApiInterception(request, context, routes)
		assert.ok(apply, 'the matching second route must not be discarded in favor of the first adapter-id entry')
		const response = await apply(async () => Response.json({ [SIMULATION_NATIVE_TOKEN_ADDRESS]: { balance: '0', allowance: '0' } }), async (_chain, request) => request.method === 'interceptor_getSimulationTokens' ? [] : '0x10')
		assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
		assert.deepEqual(await response.json(), { [SIMULATION_NATIVE_TOKEN_ADDRESS]: { balance: '16', allowance: '0' } })
	}
})

test('all vendor overlays work on HTTP pages without crypto.randomUUID and generate distinct read IDs', async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
	Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })
	const hash = '0x' + '12'.repeat(32)
	const ids: (string | number | null)[] = []
	const windowObject = { location: { origin: 'http://ordinary.example' }, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		if (request.url === balance) return Response.json({ [SIMULATION_NATIVE_TOKEN_ADDRESS]: { balance: '0', allowance: '0' } })
		if (new URL(request.url).pathname === '/swaps') return Response.json({ swaps: [{ swapType: 'CLASSIC', status: 'PENDING', txHash: hash }] })
		if (new URL(request.url).pathname.endsWith('/GetTokenPrices')) return Response.json({ tokenPrices: [] })
		return Response.json({ portfolio: { balances: [], totalValueUsd: 0 } })
	} }
	const hook = installRpcReadInterception(windowObject, async (_chain, request) => {
		ids.push(request.id)
		if (request.method === 'interceptor_getSimulationTokens') return []
		if (request.method === 'interceptor_getSimulationTokenMetadata') return [{ address: SIMULATION_NATIVE_TOKEN_ADDRESS, name: 'Ether', symbol: 'ETH', decimals: '0x12' }]
		if (request.method === 'eth_getBalance') return '0x10'
		if (request.method === 'eth_getTransactionReceipt') return { from: account, transactionHash: hash, status: '0x1' }
		throw new Error(`Unexpected HTTP-page read: ${ request.method }`)
	})
	try {
		hook.setContext({ origin: windowObject.location.origin, chainId: '0x1', address: account, methods: [], chainRoutedProxyPaths: [] })
		const responses = await Promise.all([windowObject.fetch(balance), windowObject.fetch(swaps), windowObject.fetch(portfolioRequest())])
		assert.equal(responses.every((response) => response.headers.get('x-interceptor-simulation') === 'true'), true)
		assert.equal((await responses[0]?.json())[SIMULATION_NATIVE_TOKEN_ADDRESS].balance, '16')
		assert.equal((await responses[1]?.json()).swaps[0].status, 'SUCCESS')
		assert.equal((await responses[2]?.json()).portfolio.balances[0].amount.raw, '16')
		assert.ok(ids.length >= 5, 'all metadata, balance and receipt requests were exercised')
		assert.equal(new Set(ids).size, ids.length, 'the shared page-local counter correlates concurrent adapters without collisions')
	} finally {
		hook.dispose()
		if (descriptor === undefined) Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
		else Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor)
	}
})

test('a fresh vendor registry import performs no page, timer or network work', async () => {
	const moduleUrl = new URL('../../app/inpage/ts/siteHttpApiAdapters.ts', import.meta.url).href
	const program = `
		const forbidden = (name) => () => { throw new Error('Import touched ' + name) };
		for (const name of ['window', 'document']) Object.defineProperty(globalThis, name, { configurable: true, get: forbidden(name) });
		for (const name of ['fetch', 'setTimeout', 'setInterval', 'addEventListener']) globalThis[name] = forbidden(name);
		const registry = await import(${ JSON.stringify(moduleUrl) });
		if (typeof registry.prepareSiteHttpApiInterception !== 'function') throw new Error('Missing registry export');
		console.log('pure registry loaded');
	`
	const child = Bun.spawn({ cmd: [process.execPath, '--eval', program], stdout: 'pipe', stderr: 'pipe' })
	const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	assert.equal(exitCode, 0, error)
	assert.equal(output.trim(), 'pure registry loaded')
})

test('known vendor endpoints retain original native responses when no simulation context is active', async () => {
	for (const captureBeforeContext of [false, true]) {
		const requests: RequestInfo[] = []
		const responses: Response[] = []
		const nativeFetch = async (input: RequestInfo | URL) => {
			assert.ok(input instanceof Request)
			requests.push(input)
			const response = new Response('original vendor response', { headers: { 'x-native-transport': 'untouched' } })
			responses.push(response)
			return response
		}
		const windowObject = { location: { origin: 'https://ordinary.example' }, fetch: nativeFetch }
		const hook = installRpcReadInterception(windowObject, async () => { throw new Error('An inactive session cannot issue a simulation read') }, captureBeforeContext)
		try {
			hook.setContext(undefined)
			for (const request of [new Request(balance), new Request(swaps), portfolioRequest()]) {
				const response = await windowObject.fetch(request)
				assert.strictEqual(response, responses.at(-1), 'inactive vendor endpoints return the native response object')
				assert.strictEqual(requests.at(-1), request, 'inactive vendor endpoints retain the original native request')
				assert.equal(response.headers.get('x-native-transport'), 'untouched')
			}
			assert.equal(requests.length, 3, 'inactive endpoints issue no probes or adapter follow-up queries')
		} finally { hook.dispose() }
	}
})


test('the extension site policy facade exposes the complete shared policy inventory', async () => {
	const shared = await import('../../app/shared/ts/siteBehaviorPolicy.js')
	const facade = await import('../../app/ts/utils/siteBehaviors.js')
	for (const [name, value] of Object.entries(shared)) {
		assert.equal(Reflect.get(facade, name), value, `Shared policy export ${ name } must use its canonical owner`)
	}
})

test('portfolio follow-up requests use only endpoints declared by the selected policy route', async () => {
	const original = SITE_HTTP_API_ROUTES.find((route) => route.adapter === 'portfolio' && route.responseKind === 'portfolio')
	assert.ok(original?.adapter === 'portfolio')
	for (const declared of [true, false]) {
		const route = { ...original, derivedRequests: declared ? { tokenPrices: { method: 'POST' as const, path: '/policy-owned-price-quotes' } } : {} }
		const request = portfolioRequest()
		const apply = await prepareSiteHttpApiInterception(request, context, [route])
		assert.ok(apply)
		const sent: Request[] = []
		const result = apply(async (outbound) => {
			sent.push(outbound)
			return outbound.url === portfolio ? Response.json({ portfolio: { balances: [], totalValueUsd: 0 } }) : Response.json({ tokenPrices: [] })
		}, async (_chain, rpc) => rpc.method === 'interceptor_getSimulationTokenMetadata' ? [{ address: SIMULATION_NATIVE_TOKEN_ADDRESS, name: 'Ether', symbol: 'ETH', decimals: '0x12' }] : '0x1')
		if (declared) {
			assert.equal((await result).headers.get('x-interceptor-simulation'), 'true')
			assert.deepEqual(sent.map((item) => item.url), [portfolio, new URL('/policy-owned-price-quotes', portfolio).href])
		} else {
			await assert.rejects(result, /Undeclared site HTTP API request: tokenPrices/)
			assert.deepEqual(sent.map((item) => item.url), [portfolio], 'an undeclared follow-up never reaches the native transport')
		}
	}
})

test('derived endpoint policy rejects cross-origin, query and fragment expansion before network traffic', async () => {
	const { createSiteHttpApiTransport } = await import('../../app/inpage/ts/siteHttpApiInterception.js')
	const original = SITE_HTTP_API_ROUTES.find((route) => route.adapter === 'portfolio')
	assert.ok(original?.adapter === 'portfolio')
	let sent = 0
	for (const path of ['//attacker.example/prices', 'https://attacker.example/prices', '/prices?extra=1', '/prices#fragment', '/a/../prices']) {
		const route = { ...original, derivedRequests: { tokenPrices: { method: 'POST' as const, path } } }
		const http = createSiteHttpApiTransport(portfolioRequest(), route, async () => { sent++; return Response.json({}) })
		await assert.rejects(http.sendDerived('tokenPrices', {}), /Invalid site HTTP API endpoint/)
	}
	assert.equal(sent, 0)
})

test('declared portfolio follow-ups preserve the originating request transport options and abort signal', async () => {
	const { createSiteHttpApiTransport } = await import('../../app/inpage/ts/siteHttpApiInterception.js')
	const route = SITE_HTTP_API_ROUTES.find((route) => route.adapter === 'portfolio' && route.responseKind === 'walletBalances')
	assert.ok(route)
	const abort = new AbortController()
	const request = new Request(portfolio.replace('GetPortfolio', 'GetWalletBalances'), { method: 'POST', headers: { 'x-request-context': 'same-session' }, credentials: 'include', mode: 'cors', signal: abort.signal, body: JSON.stringify(payload) })
	const sent: Request[] = []
	const http = createSiteHttpApiTransport(request, route, async (outbound) => { sent.push(outbound); return Response.json({}) })
	await http.sendOriginal()
	await http.sendDerived('portfolio', payload)
	await http.sendDerived('tokenPrices', { tokens: [] })
	assert.strictEqual(sent[0], request)
	assert.deepEqual(sent.map((item) => new URL(item.url).pathname), ['/data.v1.DataApiService/GetWalletBalances', '/data.v1.DataApiService/GetPortfolio', '/data.v1.DataApiService/GetTokenPrices'])
	for (const outbound of sent) {
		assert.equal(outbound.method, 'POST')
		assert.equal(outbound.headers.get('x-request-context'), 'same-session')
		assert.equal(outbound.credentials, 'include')
		assert.equal(outbound.mode, 'cors')
	}
	abort.abort()
	assert.equal(sent.every((item) => item.signal.aborted), true)
	assert.equal(await prepareSiteHttpApiInterception(new Request(sent[2]?.url ?? '', { method: 'POST', body: '{}' }), context), undefined, 'price quotes are a declared outbound dependency, not a new incoming interception route')
})


test('a balance descriptor missing its named contract fails explicitly rather than silently using live data', async () => {
	const original = SITE_HTTP_API_ROUTES.find((route) => route.adapter === 'balance')
	assert.ok(original)
	await assert.rejects(prepareSiteHttpApiInterception(new Request(balance), context, [{ ...original, path: /^.*$/ }]), /valid named parameters/)
})
