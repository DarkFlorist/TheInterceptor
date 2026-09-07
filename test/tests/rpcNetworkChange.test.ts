import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { getRpcNetworkChange, type RpcNetwork } from '../../app/ts/types/rpc.js'

const network: RpcNetwork = { chainId: 1n, httpsRpc: 'https://rpc.example', name: 'Network', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }

describe('RPC network change classification', () => {
	test('unchanged values do not depend on object identity or property order', () => {
		assert.deepEqual(getRpcNetworkChange(network, { minimized: false, primary: true, currencyTicker: 'ETH', currencyName: 'Ether', name: 'Network', httpsRpc: 'https://rpc.example', chainId: 1n }), { chainChanged: false, endpointChanged: false, selectionChanged: false })
	})
	test('metadata only changes the persisted selection', () => {
		assert.deepEqual(getRpcNetworkChange(network, { ...network, name: 'Renamed', primary: false, minimized: true, currencyName: 'New currency', currencyTicker: 'NEW', blockExplorer: { apiUrl: 'https://explorer.example', apiKey: 'key' } }), { chainChanged: false, endpointChanged: false, selectionChanged: true })
	})
	test('a same-chain endpoint change replaces services without changing wallet chains', () => {
		assert.deepEqual(getRpcNetworkChange(network, { ...network, httpsRpc: 'https://other.example' }), { chainChanged: false, endpointChanged: true, selectionChanged: true })
	})
	test('a chain change also replaces services even if the URL stays the same', () => {
		assert.deepEqual(getRpcNetworkChange(network, { ...network, chainId: 2n }), { chainChanged: true, endpointChanged: true, selectionChanged: true })
	})
	test('signer-only and missing networks are distinct from a configured endpoint', () => {
		const signerOnly: RpcNetwork = { chainId: 1n, httpsRpc: undefined, name: 'Signer', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		assert.deepEqual(getRpcNetworkChange(signerOnly, network), { chainChanged: false, endpointChanged: true, selectionChanged: true })
		assert.deepEqual(getRpcNetworkChange(undefined, network), { chainChanged: true, endpointChanged: true, selectionChanged: true })
	})
})
