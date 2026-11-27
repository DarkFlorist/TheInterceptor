import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getWebsiteWarningMessage } from '../../app/ts/utils/websiteData.js'

describe('website warning metadata', () => {
	test('finds the Aave warning by its hostname origin', () => {
		assert.deepEqual(getWebsiteWarningMessage('app.aave.com', true), {
			message: 'Aave relies on a centralized RPC connection which causes The Interceptor\'s Simulation Mode to not work properly with this site.',
			suggestedAlternative: undefined,
		})
		assert.equal(getWebsiteWarningMessage('app.aave.com', false), undefined)
	})
	test('warns that Lido external balance reads remain live in simulation mode', () => {
		assert.deepEqual(getWebsiteWarningMessage('stake.lido.fi', true), {
			message: 'Lido relies on a centralized RPC connection which causes The Interceptor\'s Simulation Mode to not work properly with this site.',
			suggestedAlternative: undefined,
		})
		assert.equal(getWebsiteWarningMessage('stake.lido.fi', false), undefined)
	})

})
