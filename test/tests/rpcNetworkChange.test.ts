import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { getRpcNetworkChange, getRpcChangeRoute, isSignerOnlyNetwork, resolveRpcNetworkAfterListChange } from '../../app/ts/utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'

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
		assert.equal(isSignerOnlyNetwork(signerOnly), true)
		assert.equal(isSignerOnlyNetwork(network), false)
		assert.deepEqual(getRpcNetworkChange(signerOnly, network), { chainChanged: false, endpointChanged: true, selectionChanged: true })
		assert.deepEqual(getRpcNetworkChange(undefined, network), { chainChanged: true, endpointChanged: true, selectionChanged: true })
	})
})

for (const simulationMode of [true, false]) test(`RPC routing uses one policy for local and wallet commands (simulation=${ simulationMode })`, () => {
	assert.equal(getRpcChangeRoute(network, { ...network }, simulationMode), 'unchanged')
	assert.equal(getRpcChangeRoute(network, { ...network, name: 'Renamed' }, simulationMode), 'local')
	assert.equal(getRpcChangeRoute(network, { ...network, httpsRpc: 'https://second.example' }, simulationMode), 'local')
	assert.equal(getRpcChangeRoute(network, { ...network, chainId: 2n }, simulationMode), simulationMode ? 'local' : 'wallet')
	const signerOnly: RpcNetwork = { chainId: 2n, httpsRpc: undefined, name: 'Signer only', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
	assert.equal(getRpcChangeRoute(network, signerOnly, simulationMode), simulationMode ? 'local' : 'wallet')
})


test('RPC list selection prefers exact identity before endpoint metadata or the chain primary', () => {
	const peer = { ...network, name: 'Peer', primary: true }
	const exact = { ...network, primary: false, minimized: true }
	assert.equal(resolveRpcNetworkAfterListChange(network, [network], [peer, exact]), exact)
	assert.equal(resolveRpcNetworkAfterListChange(network, [network], [peer]), peer)
})

test('RPC list metadata edits prefer the replacement over an unchanged endpoint alias', () => {
	const alias = { ...network, name: 'Existing alias' }
	const edited = { ...network, name: 'Edited selection', currencyTicker: 'NEW' }
	assert.equal(resolveRpcNetworkAfterListChange(network, [alias, network], [alias, edited]), edited)
})

test('RPC list selection uses the chain primary, then its first entry, and never another chain', () => {
	const first = { ...network, name: 'First', httpsRpc: 'https://first.example', primary: false }
	const primary = { ...network, name: 'Primary', httpsRpc: 'https://primary.example' }
	const otherChain = { ...network, chainId: 2n }
	assert.equal(resolveRpcNetworkAfterListChange(network, [network], [otherChain, first, primary]), primary)
	assert.equal(resolveRpcNetworkAfterListChange(network, [network], [otherChain, first]), first)
	assert.equal(resolveRpcNetworkAfterListChange(network, [network], [otherChain]), undefined)
})

test('RPC list edits preserve imported/custom selections absent from the previous list', () => {
	const imported = { ...network, name: 'Imported', httpsRpc: 'https://imported.example' }
	const alias = { ...imported, name: 'Same endpoint with different metadata' }
	assert.equal(resolveRpcNetworkAfterListChange(imported, [network], [alias, network]), undefined)
	assert.equal(resolveRpcNetworkAfterListChange(imported, [network], [network]), undefined)
})

test('RPC list edits never promote a signer-only selection to a configured endpoint', () => {
	const signerOnly: RpcNetwork = { name: 'Signer-only', chainId: network.chainId, httpsRpc: undefined, currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
	assert.equal(resolveRpcNetworkAfterListChange(signerOnly, [network], [network]), undefined)
})

// Importing the module and reading this error catches initialization/name regressions as well as the JSON-RPC contract.
test('a changed endpoint on the same chain is a retryable internal error, not a chain disconnection', async () => {
	const { ERROR_ACTIVE_RPC_ENDPOINT_CHANGED, ERROR_ACTIVE_RPC_NETWORK_CHANGED } = await import('../../app/ts/utils/constants.js')
	assert.equal(ERROR_ACTIVE_RPC_ENDPOINT_CHANGED.error.code, -32603)
	assert.equal(ERROR_ACTIVE_RPC_NETWORK_CHANGED.error.code, 4901)
})
