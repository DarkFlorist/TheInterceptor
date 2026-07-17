import * as assert from 'assert'
import { test } from 'bun:test'
import { signerProviderOptionLabel } from '../../app/ts/components/pages/Home.js'

test('signer provider choices visibly disambiguate identical wallet identities by UUID', () => {
	const firstProvider = {
		name: 'Example Wallet',
		rdns: 'com.example.wallet',
		uuid: '11111111-1111-4111-8111-111111111111',
	}
	const secondProvider = {
		...firstProvider,
		uuid: '22222222-2222-4222-8222-222222222222',
	}

	const firstLabel = signerProviderOptionLabel(firstProvider)
	const secondLabel = signerProviderOptionLabel(secondProvider)
	assert.notEqual(firstLabel, secondLabel)
	assert.equal(firstLabel.includes(firstProvider.uuid), true)
	assert.equal(secondLabel.includes(secondProvider.uuid), true)
})
