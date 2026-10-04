import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getIssueWithAddressString } from '../../app/ts/utils/addressValidation.js'

describe('address validation', () => {
	test('accepts uniformly uppercase addresses while still checking mixed-case addresses', () => {
		assert.equal(getIssueWithAddressString('0xDE709F2102306220921060314715629080E2FB77'), undefined)
		assert.match(getIssueWithAddressString('0x5A384227B65FA093DEC03EC34e111Db80A040615') ?? '', /Bad address checksum/u)
	})
})
