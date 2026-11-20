import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { formatManagementRoute, getManagementPageFromNavigationKey, getManagementPageHash, managementPages, parseManagementRoute, type ManagementRoute } from '../../app/ts/utils/managementPages.js'
import { getSimulationStackRoute } from '../../app/ts/utils/simulationStackTargets.js'

describe('management view routing', () => {
	test('maps each management tab to a stable hash', () => {
		assert.equal(getManagementPageHash('home'), '#home')
		assert.equal(getManagementPageHash('websites'), '#websites')
		assert.equal(getManagementPageHash('address-book'), '#address-book')
		assert.equal(getManagementPageHash('simulation-stack'), '#simulation-stack')
		assert.equal(getManagementPageHash('diagnostics'), '#diagnostics')
		assert.equal(getManagementPageHash('settings'), '#settings')
	})

	test('round-trips every route through format and parse', () => {
		const routes: readonly ManagementRoute[] = [
			...managementPages.map((page): ManagementRoute => ({ page })),
			{ page: 'websites', websiteOrigin: 'https://example.com' },
			{ page: 'websites', websiteOrigin: 'origin with spaces & symbols?#' },
			{ page: 'simulation-stack', stackTarget: { elementId: 'simulation-stack-transaction-0x1' } },
			{ page: 'simulation-stack', stackTarget: { elementId: 'simulation-stack-message-0xab', focus: 'focus-1' } },
		]
		for (const route of routes) assert.deepEqual(parseManagementRoute(formatManagementRoute(route)), route)
	})

	test('formats page-only routes as the plain tab hash and route details as query parameters', () => {
		assert.equal(formatManagementRoute({ page: 'settings' }), '#settings')
		assert.equal(formatManagementRoute({ page: 'websites', websiteOrigin: 'https://example.com' }), '#websites?origin=https%3A%2F%2Fexample.com')
		assert.equal(formatManagementRoute(getSimulationStackRoute({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')), '#simulation-stack?simulation-stack-target=simulation-stack-transaction-0x1&focus=test-focus')
		assert.deepEqual(getSimulationStackRoute(), { page: 'simulation-stack' })
	})

	test('continues to open links created before management tab hashes were namespaced', () => {
		assert.deepEqual(parseManagementRoute('#origin:https://example.com'), { page: 'websites', websiteOrigin: 'https://example.com' })
		assert.deepEqual(parseManagementRoute('#simulation-stack-target=simulation-stack-transaction-0x1'), { page: 'simulation-stack', stackTarget: { elementId: 'simulation-stack-transaction-0x1' } })
	})

	test('shows an unavailable route for unknown or malformed hashes', () => {
		assert.equal(parseManagementRoute('#unknown'), undefined)
		assert.equal(parseManagementRoute('#origin:'), undefined)
		assert.deepEqual(parseManagementRoute('#simulation-stack-target=invalid'), { page: 'simulation-stack' })
		assert.deepEqual(parseManagementRoute('#simulation-stack?simulation-stack-target=not-a-row'), { page: 'simulation-stack' })
		assert.deepEqual(parseManagementRoute('#websites?origin='), { page: 'websites' })
		assert.deepEqual(parseManagementRoute(''), { page: 'home' })
		assert.deepEqual(parseManagementRoute('#'), { page: 'home' })
	})

	test('supports standard tablist keyboard navigation with wrapping', () => {
		assert.equal(getManagementPageFromNavigationKey('home', 'ArrowRight'), 'websites')
		assert.equal(getManagementPageFromNavigationKey('websites', 'ArrowRight'), 'address-book')
		assert.equal(getManagementPageFromNavigationKey('address-book', 'ArrowRight'), 'simulation-stack')
		assert.equal(getManagementPageFromNavigationKey('simulation-stack', 'ArrowRight'), 'diagnostics')
		assert.equal(getManagementPageFromNavigationKey('diagnostics', 'ArrowRight'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('settings', 'ArrowRight'), 'home')
		assert.equal(getManagementPageFromNavigationKey('home', 'ArrowLeft'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('settings', 'Home'), 'home')
		assert.equal(getManagementPageFromNavigationKey('websites', 'End'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('websites', 'Enter'), undefined)
		assert.equal(getManagementPageFromNavigationKey(undefined, 'ArrowRight'), 'home')
		assert.equal(getManagementPageFromNavigationKey(undefined, 'ArrowLeft'), 'settings')
	})
})
