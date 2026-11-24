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

	test('finds hostname-keyed warnings for scheme-aware website origins', () => {
		const uniswapWarning = getWebsiteWarningMessage('app.uniswap.org', false)
		assert.notEqual(uniswapWarning, undefined)
		assert.deepEqual(getWebsiteWarningMessage('https://app.uniswap.org', false), uniswapWarning)
		assert.deepEqual(getWebsiteWarningMessage('https://app.aave.com', true), getWebsiteWarningMessage('app.aave.com', true))
	})

	test('does not match warnings for file origins or different hosts', () => {
		assert.equal(getWebsiteWarningMessage('file:///home/user/app.uniswap.org/index.html', false), undefined)
		assert.equal(getWebsiteWarningMessage('https://app.uniswap.org.example.com', false), undefined)
	})
})
