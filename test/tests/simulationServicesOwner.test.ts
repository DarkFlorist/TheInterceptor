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
