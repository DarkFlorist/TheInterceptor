import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getWebsiteWarningMessage } from '../../app/ts/utils/websiteData.js'

describe('website warning metadata', () => {
	test('finds the Aave warning by its hostname origin', () => {
		assert.deepEqual(getWebsiteWarningMessage('app.aave.com', true), {
			message: 'Aave relies on a centralized RPC connection which causes The Interceptor\'s Simulation Mode to not work properly with this site.',
			suggestedAlternative: undefined,
		})
	})
	test('finds compatibility warnings for canonical origins across schemes and ports', () => {
		const expected = getWebsiteWarningMessage('app.aave.com', true)
		assert.ok(expected !== undefined)
		for (const origin of ['https://app.aave.com', 'http://app.aave.com', 'https://app.aave.com:8443']) {
			assert.deepEqual(getWebsiteWarningMessage(origin, true), expected)
			assert.equal(getWebsiteWarningMessage(origin, false), undefined)
		}
		assert.equal(getWebsiteWarningMessage('https://app.aave.com.attacker.test', true), undefined)
	})
})
