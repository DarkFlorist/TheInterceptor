import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getWebsiteWarningMessage } from '../../app/ts/utils/websiteData.js'

describe('website warning metadata', () => {
	test('finds the Aave warning by its hostname origin', () => {
		assert.deepEqual(getWebsiteWarningMessage('app.aave.com', true), {
			message: `Aave relies on a centralized RPC connection which causes The Interceptor's Simulation Mode to not work properly with this site. With Gnosis Safe session compatibility enabled for an approved Gnosis Safe, supported Aave browser RPC reads use the simulation. Other networks and external services may still show live data.`,
			suggestedAlternative: undefined,
		})
		assert.equal(getWebsiteWarningMessage('app.aave.com', false), undefined)
	})
	test('describes the Lido simulation balance scope without warning in signing mode', () => {
		assert.deepEqual(getWebsiteWarningMessage('stake.lido.fi', true), {
			message: `Lido relies on a centralized RPC connection which causes The Interceptor's Simulation Mode to not work properly with this site. With Gnosis Safe session compatibility enabled for an approved Gnosis Safe, supported Lido browser RPC reads, including ether and token balances, use the simulation. External services may still show live data.`,
			suggestedAlternative: undefined,
		})
		assert.equal(getWebsiteWarningMessage('stake.lido.fi', false), undefined)
	})

})
