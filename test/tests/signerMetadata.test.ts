import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EIP6963ProviderInfo, SignerName } from '../../app/ts/types/signerTypes.js'
import { getPrettySignerName, getSignerLogo } from '../../app/ts/utils/signerMetadata.js'

describe('signer metadata', () => {
	test('keeps arbitrary provider names separate from internal signer identities', () => {
		assert.equal(SignerName.safeParse('Custom Wallet').success, false)
		assert.equal(SignerName.parse('EIP6963'), 'EIP6963')
		const provider = { uuid: '22222222-2222-4222-8222-222222222222', name: 'Custom Wallet', icon: 'data:image/png;base64,AA==', rdns: 'com.example.wallet' }
		assert.equal(EIP6963ProviderInfo.parse(provider).name, 'Custom Wallet')
		for (const name of ['NoSigner', 'NotRecognizedSigner', 'NoSignerDetected', 'EIP6963']) assert.equal(EIP6963ProviderInfo.safeParse({ ...provider, name }).success, false)
	})

	test('provides validated names and UI metadata for Ambire and Rabby', () => {
		assert.equal(SignerName.parse('Ambire'), 'Ambire')
		assert.equal(SignerName.parse('Rabby'), 'Rabby')
		assert.equal(getPrettySignerName('Ambire'), 'Ambire Wallet')
		assert.equal(getPrettySignerName('Rabby'), 'Rabby Wallet')
		assert.equal(getSignerLogo('Ambire'), '../img/signers/ambire.svg')
		assert.equal(getSignerLogo('Rabby'), '../img/signers/rabby.svg')
	})
})
