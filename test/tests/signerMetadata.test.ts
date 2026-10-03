import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { SignerName } from '../../app/ts/types/signerTypes.js'
import { getPrettySignerName, getSignerLogo } from '../../app/ts/utils/signerMetadata.js'

describe('signer metadata', () => {
	test('provides validated names and UI metadata for Ambire and Rabby', () => {
		assert.equal(SignerName.parse('Ambire'), 'Ambire')
		assert.equal(SignerName.parse('Rabby'), 'Rabby')
		assert.equal(getPrettySignerName('Ambire'), 'Ambire Wallet')
		assert.equal(getPrettySignerName('Rabby'), 'Rabby Wallet')
		assert.equal(getSignerLogo('Ambire'), '../img/signers/ambire.svg')
		assert.equal(getSignerLogo('Rabby'), '../img/signers/rabby.svg')
	})
})
