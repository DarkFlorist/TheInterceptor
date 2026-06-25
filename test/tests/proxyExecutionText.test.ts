import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getProxyRouteLabel } from '../../app/ts/components/simulationExplaining/customExplainers/SimpleSendVisualisations.js'

describe('proxy execution messaging', () => {
	test('shows a compact single-hop route label', () => {
		assert.equal(
			getProxyRouteLabel([{
				address: 1n,
				name: 'Proxy',
				type: 'contract',
				entrySource: 'User',
			}]),
			'via 1 address',
		)
	})

	test('shows a compact multi-hop route label', () => {
		assert.equal(
			getProxyRouteLabel([{
				address: 1n,
				name: 'Proxy 1',
				type: 'contract',
				entrySource: 'User',
			}, {
				address: 2n,
				name: 'Proxy 2',
				type: 'contract',
				entrySource: 'User',
			}]),
			'via 2 addresses',
		)
	})
})
