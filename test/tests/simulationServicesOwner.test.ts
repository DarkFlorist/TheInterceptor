import * as assert from 'assert'
import { test } from 'bun:test'
import { createSimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'

test('the service owner publishes the exact pair returned by every reset', () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error })
	const original = owner.getCurrent()
	try {
		for (const chainId of [2n, 3n]) {
			const network = { ...rpc, chainId, httpsRpc: `https://chain${ chainId }.invalid` }
			const replacement = owner.reset(network)
			assert.equal(owner.getCurrent(), replacement)
			assert.notEqual(replacement.ethereum, original.ethereum)
			assert.deepEqual(replacement.ethereum.getRpcEntry(), network)
		}
		// A captured pair remains a snapshot; it cannot mutate the owner's current selection.
		assert.deepEqual(original.ethereum.getRpcEntry(), rpc)
		assert.notEqual(owner.getCurrent(), original)
	} finally { owner.getCurrent().ethereum.cleanup() }
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
		owner.reset({ ...rpc, httpsRpc: `${ server.url }replacement` })
		assert.deepEqual(await snapshot.ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(await owner.getCurrent().ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(paths, ['/initial', '/replacement'])
	} finally {
		owner.getCurrent().ethereum.cleanup()
		server.stop(true)
	}
})
