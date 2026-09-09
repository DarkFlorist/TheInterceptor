import { fetchSafeAppsBalances } from '../../app/ts/background/safeAppsBalances.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSafeAppsRequestCommand } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const safeAddress = 0x1111111111111111111111111111111111111111n
const network = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
const unusedSafeState = async (): Promise<never> => { throw new Error('Balances do not need an owner or nonce lookup') }
const requestBalances = (params?: unknown) => getSafeAppsRequestCommand({ method: 'getSafeBalances', ...(params === undefined ? {} : { params }) }, 'app.example', safeAddress, network, unusedSafeState, { getBalances: async (currency) => await fetchSafeAppsBalances(network.chainId, safeAddress, currency) })
const balances = {
	fiatTotal: '23.50',
	items: [{
		tokenInfo: { type: 'ERC20', address: '0x2222222222222222222222222222222222222222', decimals: 6, name: 'USD Coin', symbol: 'USDC', logoUri: '' },
		balance: '23500000', fiatBalance: '23.50', fiatConversion: '1',
	}],
}

describe('Safe Apps indexed balances', () => {
	test('uses the selected Safe and chain, defaults to USD, and returns SDK token and fiat fields', async () => {
		const originalFetch = globalThis.fetch
		const urls: string[] = []
		globalThis.fetch = async (input, init) => {
			urls.push(String(input))
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.ok(init?.signal)
			return Response.json(balances)
		}
		try {
			assert.deepEqual(await requestBalances(), { kind: 'result', value: balances })
			assert.deepEqual(await requestBalances({ currency: 'EUR', safeAddress: '0x3333333333333333333333333333333333333333', chainId: 137 }), { kind: 'result', value: balances })
			assert.deepEqual(urls, [
				'https://safe-client.safe.global/v1/chains/1/safes/0x1111111111111111111111111111111111111111/balances/usd',
				'https://safe-client.safe.global/v1/chains/1/safes/0x1111111111111111111111111111111111111111/balances/eur',
			])
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('preserves the SDK native balance shape with a null logo URI', async () => {
		const originalFetch = globalThis.fetch
		const nativeBalance = { fiatTotal: '23.50', items: [{ tokenInfo: { type: 'ETHER', address: '0x0000000000000000000000000000000000000000', decimals: 18, name: 'Ether', symbol: 'ETH', logoUri: null }, balance: '10000000000000000', fiatBalance: '23.50', fiatConversion: '2350' }] }
		globalThis.fetch = async () => Response.json(nativeBalance)
		try {
			assert.deepEqual(await requestBalances(), { kind: 'result', value: nativeBalance })
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('rejects malformed currency params before contacting the service', async () => {
		const originalFetch = globalThis.fetch
		let calls = 0
		globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch') }
		try {
			for (const params of [null, [], 'usd', { currency: 123 }, { currency: '../usd' }, { currency: '' }]) {
				await assert.rejects(requestBalances(params), /fiat currency code/)
			}
			assert.equal(calls, 0)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	test('preserves service failures as actionable errors rather than empty balances', async () => {
		const originalFetch = globalThis.fetch
		try {
			globalThis.fetch = async () => new Response('Unavailable', { status: 503 })
			await assert.rejects(requestBalances(), (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32000 && /HTTP 503/.test(error.message))
			globalThis.fetch = async () => Response.json({ fiatTotal: '0', items: [{ balance: '0' }] })
			await assert.rejects(requestBalances(), /invalid balance response/)
			globalThis.fetch = async () => new Response('not json')
			await assert.rejects(requestBalances(), /invalid JSON/)
			globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
			await assert.rejects(requestBalances(), /balance service could not be reached/)
			globalThis.fetch = async () => { throw new Error('Unexpected programmer error') }
			await assert.rejects(requestBalances(), /Unexpected programmer error/)
			globalThis.fetch = async () => Response.json({ fiatTotal: '0', items: [] })
			assert.deepEqual(await requestBalances(), { kind: 'result', value: { fiatTotal: '0', items: [] } })
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
