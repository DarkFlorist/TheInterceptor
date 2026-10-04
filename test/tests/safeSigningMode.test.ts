import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isActiveSigningSafe, resolveSigningSafe } from '../../app/ts/utils/activeAddressSelection.js'

const ownerAddress = 0x5678n

const safeEntry = {
	type: 'safe' as const,
	name: 'Treasury',
	address: 0x1234n,
	chainId: 1n,
	entrySource: 'User' as const,
	useAsActiveAddress: true,
	safeSimulationSignerAddress: ownerAddress,
	safeSignerAddresses: [ownerAddress],
}

describe('Gnosis Safe signing-mode selection', () => {
	test('selects the configured Safe only for an owner on its recorded chain', () => {
		assert.equal(resolveSigningSafe(safeEntry.address, safeEntry.chainId, [ownerAddress], [safeEntry]), safeEntry)
		assert.equal(resolveSigningSafe(safeEntry.address, 2n, [ownerAddress], [safeEntry]), undefined)
		assert.equal(resolveSigningSafe(safeEntry.address, safeEntry.chainId, [0x9999n], [safeEntry]), undefined)
	})

	test('does not select a Safe without a configured signing Safe address', () => {
		assert.equal(resolveSigningSafe(undefined, safeEntry.chainId, [ownerAddress], [safeEntry]), undefined)
	})

	test('does not require a simulation signer in signing mode', () => {
		const safeWithoutSimulationSigner = { ...safeEntry, safeSimulationSignerAddress: undefined }
		assert.deepEqual(resolveSigningSafe(safeEntry.address, safeEntry.chainId, [ownerAddress], [safeWithoutSimulationSigner]), safeWithoutSimulationSigner)
	})

	test('uses the shared owned-Safe predicate for signing and Safe Apps mode', () => {
		assert.equal(isActiveSigningSafe(safeEntry, false, safeEntry.address, safeEntry.chainId, [ownerAddress], [safeEntry]), true)
		assert.equal(isActiveSigningSafe(safeEntry, true, safeEntry.address, safeEntry.chainId, [ownerAddress], [safeEntry]), false)
		assert.equal(isActiveSigningSafe(safeEntry, false, safeEntry.address, safeEntry.chainId, [0x9999n], [safeEntry]), false)
		assert.equal(isActiveSigningSafe({ type: 'contact', name: 'EOA', address: ownerAddress, entrySource: 'User', useAsActiveAddress: true }, false, ownerAddress, safeEntry.chainId, [ownerAddress], [safeEntry]), false)
	})
})
