import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { installRpcReadInterception } from '../../app/inpage/ts/rpcReadInterception.js'
import { SIMULATED_SITE_RPC_METHODS } from '../../app/ts/utils/siteBehaviors.js'

const account = '0x1234567890123456789012345678901234567890'
const native = '0x0000000000000000000000000000000000000000'
const wrapped = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const base = 'https://entry-gateway.backend-prod.api.uniswap.org'
const path = '/data.v1.DataApiService/GetPortfolio'
const context = { origin: 'https://unlisted.example', address: account, chainId: '0x1', methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] }
const body = { walletAccount: { platformAddresses: [{ address: account }] }, chainIds: [1, 137], modifier: { address: account }, multichain: false }
const token = { chainId: 1, address: native, decimals: 18, name: 'Ethereum', symbol: 'ETH', type: 'TOKEN_TYPE_NATIVE' }
const existing = { token, amount: { raw: '1000000000000000000', amount: 1 }, priceUsd: 2000, pricePercentChange1d: 5, valueUsd: 2000 }
const other = { ...existing, token: { ...token, chainId: 137 }, valueUsd: 2000 }
const live = { portfolio: { balances: [existing, other], totalValueUsd: 4000, totalValueAbsoluteChange1d: 20, totalValuePercentChange1d: 0.5 } }
const metadata = [{ address: '0x' + 'ee'.repeat(20), name: 'Ethereum', symbol: 'ETH', decimals: '0x12' }, { address: wrapped, name: 'Wrapped Ether', symbol: 'WETH', decimals: '0x12' }]

function harness(response: unknown = live, rpc?: (method: string) => Promise<unknown>) {
	const requests: Request[] = []
	const windowObject = { location: { origin: context.origin }, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		requests.push(request)
		const pathname = new URL(request.url).pathname
		if (pathname.endsWith('/GetTokenPrices')) return Response.json({ tokenPrices: [{ chainId: 1, address: wrapped, priceUsd: 2000 }] })
		if (pathname === path && new URL(requests[0]?.url ?? request.url).pathname.endsWith('/GetWalletBalances')) return Response.json(live)
		return Response.json(response)
	} }
	const hook = installRpcReadInterception(windowObject, async (_chain, request) => {
		if (rpc !== undefined) return await rpc(request.method)
		if (request.method === 'interceptor_getSimulationTokenMetadata') return metadata
		if (request.method === 'eth_getBalance') return '0x1bc16d674ec80000'
		if (request.method === 'eth_call') return '0x6f05b59d3b20000'
		throw new Error('unexpected simulation request')
	})
	hook.setContext(context)
	const fetch = async (payload: unknown = body, resource = base + path, signal?: AbortSignal) => await windowObject.fetch(resource, { method: 'POST', signal, body: JSON.stringify(payload) })
	return { fetch, hook, requests }
}

test('indexed flat balances add simulation-only holdings and update selected-chain quantities and totals', async () => {
	const h = harness()
	const response = await h.fetch()
	const data = await response.json()
	assert.equal(response.headers.get('x-interceptor-simulation'), 'true')
	assert.deepEqual(data.portfolio.balances[1], other)
	assert.deepEqual(data.portfolio.balances[0].amount, { raw: '2000000000000000000', amount: 2 })
	assert.equal(data.portfolio.balances[2].token.symbol, 'WETH')
	assert.deepEqual(data.portfolio.balances[2].amount, { raw: '500000000000000000', amount: 0.5 })
	assert.equal(data.portfolio.totalValueUsd, 7000)
	assert.equal(data.portfolio.totalValueAbsoluteChange1d, undefined, 'live position performance must not be carried over to overridden holdings')
	assert.equal(h.requests.length, 2, 'only the native portfolio and missing-token market prices use HTTP')
})

test('multichain group totals preserve unrelated chains and exclude hidden holdings', async () => {
	const row = { chainId: 1, address: native, decimals: 18, amount: existing.amount, valueUsd: 2000 }
	const group = { name: 'Ethereum', symbol: 'ETH', priceUsd: 2000, totalValueUsd: 4000, totalAmount: { raw: '2000000000000000000', amount: 2 }, chainBalances: [row, { ...row, chainId: 137 }] }
	const hidden = { ...group, name: 'Hidden', isHidden: true, chainBalances: [{ ...row, address: wrapped, isHidden: true }], totalValueUsd: 0 }
	const h = harness({ portfolio: { multichainBalances: [group, hidden], totalValueUsd: 4000 } })
	const data = await (await h.fetch({ ...body, multichain: true })).json()
	assert.deepEqual(data.portfolio.multichainBalances[0].chainBalances[1], group.chainBalances[1])
	assert.deepEqual(data.portfolio.multichainBalances[0].totalAmount, { raw: '3000000000000000000', amount: 3 })
	assert.equal(data.portfolio.multichainBalances[0].totalValueUsd, 6000)
	assert.equal(data.portfolio.multichainBalances[1].totalValueUsd, 0)
	assert.equal(data.portfolio.totalValueUsd, 6000)
})

test('empty flat balances do not suppress populated multichain holdings', async () => {
	const row = { chainId: 1, address: native, decimals: 18, amount: existing.amount, valueUsd: 2000 }
	const group = { name: 'Ethereum', symbol: 'ETH', priceUsd: 2000, totalValueUsd: 4000, totalAmount: { raw: '2000000000000000000', amount: 2 }, chainBalances: [row, { ...row, chainId: 137 }] }
	const hidden = { ...group, name: 'Hidden', isHidden: true, chainBalances: [{ ...row, address: wrapped, isHidden: true }], totalValueUsd: 0 }
	const h = harness({ portfolio: { balances: [], multichainBalances: [group, hidden], totalValueUsd: 4000 } })
	const data = await (await h.fetch({ ...body, multichain: true })).json()
	assert.deepEqual(data.portfolio.multichainBalances[0].chainBalances[1], group.chainBalances[1])
	assert.deepEqual(data.portfolio.multichainBalances[0].totalAmount, { raw: '3000000000000000000', amount: 3 })
	assert.equal(data.portfolio.multichainBalances[0].totalValueUsd, 6000)
	assert.equal(data.portfolio.multichainBalances[1].totalValueUsd, 0)
	assert.equal(data.portfolio.totalValueUsd, 6000)
})

test('summary totals use the same simulated token delta while preserving pools and earn balances', async () => {
	const summary = { balance: { total: { valueUsd: 4100, absoluteChange1d: 10 }, tokens: { valueUsd: 4000 }, pools: { valueUsd: 70 }, earn: { valueUsd: 30 } } }
	const h = harness(summary)
	const data = await (await h.fetch(body, base + '/data.v1.DataApiService/GetWalletBalances')).json()
	assert.equal(data.balance.tokens.valueUsd, 7000)
	assert.equal(data.balance.total.valueUsd, 7100)
	assert.deepEqual(data.balance.pools, summary.balance.pools)
	assert.deepEqual(data.balance.earn, summary.balance.earn)
	assert.equal(data.balance.total.absoluteChange1d, undefined)
})

test('indexed portfolio interception rejects other accounts, chains, APIs and revoked sessions', async () => {
	for (const payload of [{ ...body, chainIds: [137] }, { ...body, walletAccount: { platformAddresses: [{ address: wrapped }] } }, { ...body, modifier: { address: wrapped } }, { ...body, walletAccount: { platformAddresses: [{ address: account }, { address: wrapped }] } }]) {
		const h = harness(undefined, async () => { throw new Error('must not simulate') })
		assert.deepEqual(await (await h.fetch(payload)).json(), live)
	}
	const h = harness(undefined, async () => { throw new Error('must not simulate') })
	h.hook.setContext(undefined)
	assert.deepEqual(await (await h.fetch()).json(), live)
})

test('schema drift stays native and simulation failures stay failures', async () => {
	for (const response of [{ bad: 'shape' }, { portfolio: { balances: [{ token }] } }, { portfolio: { multichainBalances: [{}] } }]) {
		const h = harness(response, async () => { throw new Error('must not simulate') })
		assert.deepEqual(await (await h.fetch()).json(), response)
	}
	const h = harness(undefined, async () => { throw new Error('simulation unavailable') })
	await assert.rejects(h.fetch(), /simulation unavailable/)
})

test('an empty indexed portfolio still shows native and simulation-only token holdings', async () => {
	const h = harness({ portfolio: { balances: [], totalValueUsd: 0 } })
	const data = await (await h.fetch()).json()
	assert.equal(data.portfolio.balances.length, 2)
	assert.deepEqual(data.portfolio.balances.map((row: { amount: { raw: string } }) => row.amount.raw), ['2000000000000000000', '500000000000000000'])
})

test('indexed raw quantities remain exact above JavaScript integer precision', async () => {
	const raw = 2n ** 256n - 1n
	const h = harness(undefined, async (method) => method === 'interceptor_getSimulationTokenMetadata' ? metadata.slice(0, 1) : '0x' + raw.toString(16))
	const data = await (await h.fetch()).json()
	assert.equal(data.portfolio.balances[0].amount.raw, raw.toString())
	assert.equal(Number.isFinite(data.portfolio.totalValueUsd), true)
})

test('indexed portfolio replies are rejected after account, chain, permission or abort changes', async () => {
	for (const action of ['account', 'chain', 'revoke', 'abort']) {
		let entered: (() => void) | undefined
		let finish: ((value: unknown) => void) | undefined
		const started = new Promise<void>((resolve) => { entered = resolve })
		const h = harness(undefined, async (method) => {
			if (method !== 'interceptor_getSimulationTokenMetadata') return '0x0'
			entered?.()
			return await new Promise((resolve) => { finish = resolve })
		})
		const controller = new AbortController()
		const pending = h.fetch(body, base + path, controller.signal)
		await started
		if (action === 'abort') controller.abort(new Error('cancelled'))
		else h.hook.setContext(action === 'account' ? { ...context, address: wrapped } : action === 'chain' ? { ...context, chainId: '0x89' } : undefined)
		finish?.([])
		await assert.rejects(pending, action === 'abort' ? /cancelled/ : /session changed/)
	}
})


test('multichain fractional totals normalize different decimal scales without losing raw precision', async () => {
	for (const decimals of [0, 6, 18]) {
		const selectedRaw = 2n * 10n ** BigInt(decimals)
		const row = { chainId: 1, address: wrapped, decimals, amount: { raw: selectedRaw.toString(), amount: 2 }, valueUsd: 4000 }
		const otherRow = { ...row, chainId: 137, decimals: 18, amount: { raw: '500000000000000001', amount: 0.5 }, valueUsd: 1000 }
		const h = harness({ portfolio: { multichainBalances: [{ name: 'Wrapped Ether', symbol: 'WETH', priceUsd: 2000, chainBalances: [row, otherRow] }], totalValueUsd: 5000 } }, async (method) => method === 'interceptor_getSimulationTokenMetadata' ? [] : '0x' + selectedRaw.toString(16))
		const data = await (await h.fetch({ ...body, multichain: true })).json()
		const total = data.portfolio.multichainBalances[0].totalAmount
		assert.equal(BigInt(total.raw), 2500000000000000001n)
		assert.equal(total.amount, 2.5)
	}
})

test('simulation-only multichain groups keep fractional raw totals in exact base units', async () => {
	const h = harness({ portfolio: { multichainBalances: [], totalValueUsd: 0 } })
	const data = await (await h.fetch({ ...body, multichain: true })).json()
	const totals = data.portfolio.multichainBalances.map((group: { totalAmount: { raw: string, amount: number } }) => group.totalAmount)
	assert.deepEqual(totals, [{ raw: '2000000000000000000', amount: 2 }, { raw: '500000000000000000', amount: 0.5 }])
	assert.equal(BigInt(totals[1].raw), 500000000000000000n)
})


test('flat and multichain views share simulated quantities when both are present', async () => {
	const group = { name: 'Ether', symbol: 'ETH', priceUsd: 2000, chainBalances: [
		{ chainId: 1, address: native, decimals: 18, amount: existing.amount, valueUsd: 2000 },
		{ chainId: 137, address: native, decimals: 18, amount: other.amount, valueUsd: 2000 },
	] }
	for (const { flat, groups } of [{ flat: [], groups: [group] }, { flat: [existing, other], groups: [group] }, { flat: [existing, other], groups: [] }]) {
		const h = harness({ portfolio: { balances: flat, multichainBalances: groups, totalValueUsd: 4000 } })
		const data = await (await h.fetch()).json()
		const flatNative = data.portfolio.balances.find((row: { token: { address: string, chainId: number } }) => row.token.address === native && row.token.chainId === 1)
		const groupedNative = data.portfolio.multichainBalances[0].chainBalances[0]
		assert.deepEqual(flatNative.amount, groupedNative.amount)
		assert.equal(flatNative.amount.raw, '2000000000000000000')
		assert.equal(flatNative.valueUsd, groupedNative.valueUsd)
		if (groups.length > 0) assert.deepEqual(data.portfolio.multichainBalances[0].chainBalances[1], group.chainBalances[1])
		else assert.deepEqual(data.portfolio.balances.find((row: { token: { chainId: number } }) => row.token.chainId === 137), other)
	}
})


test('malformed grouped rows stay native even when valid flat balances are present', async () => {
	for (const row of [
		{ chainId: 1, address: native, decimals: 18, amount: { raw: 'invalid' } },
		{ chainId: 137, address: native, decimals: 18 },
		{ chainId: 1, address: native, decimals: -1, amount: { raw: '1' } },
		'unexpected-row',
	]) {
		const response = { portfolio: { ...live.portfolio, multichainBalances: [{ name: 'Ether', priceUsd: 2000, chainBalances: [row] }] } }
		const h = harness(response, async () => { throw new Error('Malformed views must not start simulation reads') })
		const result = await h.fetch()
		assert.deepEqual(await result.json(), response)
		assert.equal(result.headers.has('x-interceptor-simulation'), false)
	}
})


test('simulated flat rows discard live position changes while retaining price changes and untouched chains', async () => {
	const performance = { absoluteChange1d: 10, percentChange1d: 5, totalValueAbsoluteChange1d: 20, totalValuePercentChange1d: 1 }
	const selected = { ...existing, ...performance }
	const untouched = { ...other, ...performance }
	const h = harness({ portfolio: { balances: [selected, untouched], totalValueUsd: 4000 } })
	const data = await (await h.fetch()).json()
	const updated = data.portfolio.balances[0]
	assert.equal(updated.amount.raw, '2000000000000000000')
	for (const key of Object.keys(performance)) assert.equal(key in updated, false, key)
	assert.equal(updated.pricePercentChange1d, selected.pricePercentChange1d)
	assert.deepEqual(data.portfolio.balances[1], untouched)
})

test('simulated multichain rows discard live position changes in grouped and combined views', async () => {
	const performance = { absoluteChange1d: 10, percentChange1d: 5, totalValueAbsoluteChange1d: 20, totalValuePercentChange1d: 1 }
	const selected = { chainId: 1, address: native, decimals: 18, amount: existing.amount, valueUsd: 2000, pricePercentChange1d: 7, ...performance }
	const untouched = { ...selected, chainId: 137 }
	const group = { name: 'Ether', symbol: 'ETH', priceUsd: 2000, pricePercentChange1d: 9, chainBalances: [selected, untouched], ...performance }
	for (const withFlat of [false, true]) {
		const h = harness({ portfolio: { multichainBalances: [group], ...withFlat ? { balances: [{ ...existing, ...performance }, { ...other, ...performance }] } : {}, totalValueUsd: 4000 } })
		const data = await (await h.fetch()).json()
		const updated = data.portfolio.multichainBalances[0].chainBalances[0]
		assert.equal(updated.amount.raw, '2000000000000000000')
		for (const key of Object.keys(performance)) assert.equal(key in updated, false, key)
		assert.equal(updated.pricePercentChange1d, selected.pricePercentChange1d)
		assert.equal(data.portfolio.multichainBalances[0].pricePercentChange1d, group.pricePercentChange1d)
		assert.deepEqual(data.portfolio.multichainBalances[0].chainBalances[1], untouched)
		if (withFlat) for (const key of Object.keys(performance)) assert.equal(key in data.portfolio.balances[0], false, key)
	}
})


test('new selected-chain holdings join existing token groups on other chains', async () => {
	const untouched = { chainId: 137, address: wrapped.toUpperCase().replace('0X', '0x'), decimals: 18, amount: { raw: '1000000000000000000', amount: 1 }, valueUsd: 2000 }
	const group = { name: 'Wrapped Ether', symbol: 'WETH', priceUsd: 2000, totalAmount: untouched.amount, totalValueUsd: 2000, chainBalances: [untouched] }
	for (const withFlat of [false, true]) {
		const otherWrapped = { token: { ...token, chainId: 137, address: wrapped }, amount: untouched.amount, valueUsd: 2000 }
		const h = harness({ portfolio: { multichainBalances: [group], ...withFlat ? { balances: [otherWrapped] } : {}, totalValueUsd: 2000 } })
		const data = await (await h.fetch({ ...body, multichain: true })).json()
		const wrappedGroups = data.portfolio.multichainBalances.filter((candidate: { symbol: string }) => candidate.symbol === 'WETH')
		assert.equal(wrappedGroups.length, 1, 'the new chain must not create another group for the same token')
		const updated = wrappedGroups[0]
		assert.deepEqual(updated.chainBalances[0], untouched)
		assert.equal(updated.chainBalances.length, 2)
		assert.equal(updated.chainBalances[1].chainId, 1)
		assert.equal(updated.chainBalances[1].amount.raw, '500000000000000000')
		assert.deepEqual(updated.totalAmount, { raw: '1500000000000000000', amount: 1.5 })
		assert.equal(updated.totalValueUsd, 3000)
		assert.equal(data.portfolio.totalValueUsd, 3000)
	}
})
