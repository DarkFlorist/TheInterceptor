import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSafeSigningEntry } from '../../app/ts/types/addressBookTypes.js'

const safeEntry = {
	type: 'safe' as const,
	name: 'Treasury',
	address: 0x1234n,
	chainId: 1n,
	entrySource: 'User' as const,
	useAsActiveAddress: true,
	safeSimulationSignerAddress: 0x5678n,
}

const signingSettings = {
	simulationMode: false,
	useSignersAddressAsActiveAddress: false,
	activeSimulationAddress: safeEntry.address,
	chainId: safeEntry.chainId,
}

describe('Gnosis Safe signing-mode selection', () => {
	test('selects the configured Safe only on its recorded chain', () => {
		assert.equal(getSafeSigningEntry([safeEntry], signingSettings), safeEntry)
		assert.equal(getSafeSigningEntry([safeEntry], { ...signingSettings, chainId: 2n }), undefined)
	})

	test('does not select a Safe in simulation or signer-address mode', () => {
		assert.equal(getSafeSigningEntry([safeEntry], { ...signingSettings, simulationMode: true }), undefined)
		assert.equal(getSafeSigningEntry([safeEntry], { ...signingSettings, useSignersAddressAsActiveAddress: true }), undefined)
	})

	test('does not require a simulation signer in signing mode', () => {
		const safeWithoutSimulationSigner = { ...safeEntry, safeSimulationSignerAddress: undefined }
		assert.deepEqual(getSafeSigningEntry([safeWithoutSimulationSigner], signingSettings), safeWithoutSimulationSigner)
	})
})
