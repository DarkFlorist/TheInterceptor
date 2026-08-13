import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSigningQuarantineCodes } from '../../app/ts/background/windows/personalSign.js'
import { decodeMessage } from '../../app/ts/components/pages/PersonalSign.js'

describe('personal sign quarantine checks', () => {
	test('only decodes complete 0x-prefixed byte strings', () => {
		assert.equal(decodeMessage('0x6869'), 'hi')
		assert.equal(decodeMessage('6869'), '6869')
		assert.equal(decodeMessage('0xabc'), '0xabc')
	})
	test('quarantines an account mismatch when the signed message has no chain ID', () => {
		assert.deepEqual(getSigningQuarantineCodes(undefined, 1n, 0x1n, 0x2n, undefined), {
			quarantine: true,
			quarantineReasons: ['The signature request is for an account that is different from your active address.'],
		})
	})

	test('does not quarantine a matching account solely because the message has no chain ID', () => {
		assert.deepEqual(getSigningQuarantineCodes(undefined, 1n, 0x1n, 0x1n, undefined), {
			quarantine: false,
			quarantineReasons: [],
		})
	})
})
