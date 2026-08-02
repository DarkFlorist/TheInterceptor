import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getConfiguredSafeSigningEntry } from '../../app/ts/types/addressBookTypes.js'

const safeEntry = {
	type: 'safe' as const,
	name: 'Treasury',
	address: 0x1234n,
	chainId: 1n,
	entrySource: 'User' as const,
	useAsActiveAddress: true,
	safeSignerAddress: 0x5678n,
}

const signingSettings = {
	simulationMode: false,
	useSignersAddressAsActiveAddress: false,
	activeSimulationAddress: safeEntry.address,
	chainId: safeEntry.chainId,
}

describe('Gnosis Safe signing-mode selection', () => {
	test('selects the configured Safe only on its recorded chain', () => {
		assert.equal(getConfiguredSafeSigningEntry([safeEntry], signingSettings), safeEntry)
		assert.equal(getConfiguredSafeSigningEntry([safeEntry], { ...signingSettings, chainId: 2n }), undefined)
	})

	test('does not select a Safe in simulation or signer-address mode', () => {
		assert.equal(getConfiguredSafeSigningEntry([safeEntry], { ...signingSettings, simulationMode: true }), undefined)
		assert.equal(getConfiguredSafeSigningEntry([safeEntry], { ...signingSettings, useSignersAddressAsActiveAddress: true }), undefined)
	})

	test('requires the selected Safe to have an active configured signer', () => {
		assert.equal(getConfiguredSafeSigningEntry([{ ...safeEntry, safeSignerAddress: undefined }], signingSettings), undefined)
	})
})
