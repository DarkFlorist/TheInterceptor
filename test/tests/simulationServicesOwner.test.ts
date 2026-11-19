import * as assert from 'assert'
import { DEFAULT_RPCS } from '../../app/ts/config/defaults.js'
import { createEthereumWithGetBlockCounter, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { test } from 'bun:test'
import { createSimulationServicesOwner, createSimulationServicesOwnerForServices } from '../../app/ts/simulation/serviceLifecycle.js'

test('the service owner publishes each installed pair and retains captured snapshots', () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error })
	const original = owner.getCurrent()
	try {
		for (const chainId of [2n, 3n]) {
			const network = { ...rpc, chainId, httpsRpc: `https://chain${ chainId }.invalid` }
			owner.ensureNetwork(network)
			const replacement = owner.getCurrent()
			assert.notEqual(replacement.ethereum, original.ethereum)
			assert.deepEqual(replacement.ethereum.getRpcEntry(), network)
		}
		// A captured pair remains a snapshot; it cannot mutate the owner's current selection.
		assert.deepEqual(original.ethereum.getRpcEntry(), rpc)
		assert.notEqual(owner.getCurrent(), original)
	} finally { owner.getCurrent().ethereum.cleanup() }
})


test('network reconciliation permanently retires the replaced client', () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async () => undefined)
	const replaced = owner.getCurrent()
	try {
		assert.equal(owner.ensureNetwork({ ...rpc, chainId: 10n, httpsRpc: 'https://replacement.invalid' }), 'replaced')
		replaced.ethereum.setBlockPolling(true)
		assert.equal(replaced.ethereum.isBlockPolling(), false)
	} finally {
		replaced.ethereum.cleanup()
		owner.getCurrent().ethereum.cleanup()
	}
})

test('a captured client can execute RPC work after the owner installs its replacement', async () => {
	const paths: string[] = []
	const server = Bun.serve({
		hostname: '127.0.0.1', port: 0,
		async fetch(request) {
			const message: unknown = await request.json()
			if (typeof message !== 'object' || message === null || !('id' in message)) throw new Error('Missing fixture request ID')
			paths.push(new URL(request.url).pathname)
			return Response.json({ jsonrpc: '2.0', id: message.id, result: '0x01' })
		},
	})
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: `${ server.url }initial`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error })
	const snapshot = owner.getCurrent()
	try {
		owner.ensureNetwork({ ...rpc, httpsRpc: `${ server.url }replacement` })
		assert.deepEqual(await snapshot.ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(await owner.getCurrent().ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(paths, ['/initial', '/replacement'])
	} finally {
		owner.getCurrent().ethereum.cleanup()
		server.stop(true)
	}
})

test('reconciles selected networks against the installed client', () => {
	const initialNetwork = DEFAULT_RPCS[0]
	if (initialNetwork === undefined) throw new Error('Expected a default RPC endpoint')
	const owner = createSimulationServicesOwner(initialNetwork, async () => undefined, async (_ethereum, error) => { throw error })
	try {
		const initialServices = owner.getCurrent()
		assert.equal(owner.ensureNetwork({ ...initialNetwork, name: 'Renamed endpoint' }), 'unchanged')
		assert.equal(owner.getCurrent(), initialServices)
		const renamed = { ...initialNetwork, name: 'Fresh metadata' }
		assert.equal(owner.ensureNetwork(renamed, { updateMetadata: true }), 'replaced')
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().name, renamed.name)
		assert.equal(initialServices.ethereum.getRpcEntry().name, initialNetwork.name, 'Metadata replacement preserves existing snapshots')
		assert.equal(owner.ensureNetwork(renamed, { updateMetadata: true }), 'unchanged')
		const nextNetwork = { ...initialNetwork, httpsRpc: 'https://replacement.example' }
		assert.equal(owner.ensureNetwork(nextNetwork), 'replaced')
		const replacementServices = owner.getCurrent()
		assert.notEqual(replacementServices, initialServices)
		assert.equal(replacementServices.ethereum.getRpcEntry().httpsRpc, nextNetwork.httpsRpc)
		assert.equal(owner.ensureNetwork({ ...nextNetwork, httpsRpc: undefined }), 'signerOnly')
		assert.equal(owner.ensureNetwork(nextNetwork), 'unchanged')
		assert.equal(owner.getCurrent(), replacementServices, 'Signer-only selections retain the installed fallback endpoint')
		owner.ensureNetwork(initialNetwork)
		const resetServices = owner.getCurrent()
		owner.ensureNetwork(initialNetwork)
		assert.equal(owner.getCurrent(), resetServices, 'Repeated selections preserve the installed services')
		owner.ensureNetwork({ ...initialNetwork, chainId: initialNetwork.chainId + 1n })
		assert.notEqual(owner.getCurrent(), resetServices, 'A different chain needs new services even at the same URL')
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})

test('the test owner tracks replacement selections without changing injected client metadata', () => {
	const services = createEthereumWithGetBlockCounter({ count: 0 })
	const initialNetwork = services.ethereum.getRpcEntry()
	let replacements = 0
	const owner = createTestSimulationServicesOwner(services, () => { replacements++; return services })
	assert.equal(owner.ensureNetwork(initialNetwork), 'unchanged')
	assert.equal(owner.ensureNetwork({ ...initialNetwork, name: 'Renamed' }), 'unchanged')
	assert.equal(replacements, 0)
	const next = { ...initialNetwork, httpsRpc: 'https://replacement.example' }
	assert.equal(owner.ensureNetwork(next), 'replaced')
	assert.equal(owner.getCurrent(), services)
	assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, initialNetwork.httpsRpc)
	assert.equal(owner.ensureNetwork(next), 'unchanged')
	assert.equal(replacements, 1)
})


test('injected owner selection is explicit and advances only after replacement succeeds', () => {
	const services = createEthereumWithGetBlockCounter({ count: 0 })
	const actual = services.ethereum.getRpcEntry()
	const installed = { ...actual, httpsRpc: 'https://explicit-initial.example' }
	const next = { ...installed, httpsRpc: 'https://explicit-next.example' }
	let shouldFail = true
	let replacements = 0
	const owner = createSimulationServicesOwnerForServices(installed, services, (current) => {
		replacements++
		if (shouldFail) throw new Error('Replacement failed')
		return current
	})
	assert.equal(owner.ensureNetwork(installed), 'unchanged')
	assert.throws(() => owner.ensureNetwork(next), /Replacement failed/)
	assert.equal(owner.ensureNetwork(installed), 'unchanged')
	shouldFail = false
	assert.equal(owner.ensureNetwork(next), 'replaced')
	assert.equal(owner.ensureNetwork(next), 'unchanged')
	assert.equal(replacements, 2)
	assert.equal(owner.getCurrent(), services)
	assert.deepEqual(services.ethereum.getRpcEntry(), actual)
})
