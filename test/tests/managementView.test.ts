import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createMountedManagementPages, getManagementHashForOpenRequest, getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, getSimulationStackManagementHash, mountManagementPage } from '../../app/ts/utils/managementPages.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'
import { getWebsiteOriginFromHash, getWebsiteOriginHash } from '../../app/ts/utils/websiteAccessHash.js'
import type { TransactionOrMessageIdentifier } from '../../app/ts/types/interceptor-messages.js'

const managementViewSource = await Bun.file(new URL('../../app/ts/components/pages/ManagementView.tsx', import.meta.url)).text()

describe('management view routing', () => {
	test('maps each management tab to a stable hash', () => {
		assert.equal(getManagementPageHash('home'), '#home')
		assert.equal(getManagementPageHash('websites'), '#websites')
		assert.equal(getManagementPageHash('address-book'), '#address-book')
		assert.equal(getManagementPageHash('simulation-stack'), '#simulation-stack')
		assert.equal(getManagementPageHash('diagnostics'), '#diagnostics')
		assert.equal(getManagementPageHash('settings'), '#settings')
	})

	test('routes simulation stack links into the shared management tab', () => {
		const identifier: TransactionOrMessageIdentifier = { type: 'Transaction', transactionIdentifier: 1n }
		const targetHash = getSimulationStackTargetHash(identifier, 'test-focus')

		assert.equal(getSimulationStackManagementHash(), '#simulation-stack')
		assert.equal(getSimulationStackManagementHash(identifier).startsWith('#simulation-stack-target='), true)
		assert.equal(getManagementPageFromHash(targetHash), 'simulation-stack')
	})

	test('maps popup controls into the shared management navigation', () => {
		assert.equal(getManagementHashForOpenRequest('popup_openManagement'), '#home')
		assert.equal(getManagementHashForOpenRequest('popup_openWebsiteAccess'), '#websites')
		assert.equal(getManagementHashForOpenRequest('popup_openAddressBook'), '#address-book')
		assert.equal(getManagementHashForOpenRequest('popup_openSettings'), '#settings')
	})

	test('selects management tabs from their hashes', () => {
		assert.equal(getManagementPageFromHash('#home'), 'home')
		assert.equal(getManagementPageFromHash('#websites'), 'websites')
		assert.equal(getManagementPageFromHash('#address-book'), 'address-book')
		assert.equal(getManagementPageFromHash('#simulation-stack'), 'simulation-stack')
		assert.equal(getManagementPageFromHash('#diagnostics'), 'diagnostics')
		assert.equal(getManagementPageFromHash('#settings'), 'settings')
	})

	test('uses the website detail hash in both the website view and management router', () => {
		const hash = getWebsiteOriginHash('https://example.com')
		assert.equal(getWebsiteOriginFromHash(hash), 'https://example.com')
		assert.equal(getManagementPageFromHash(hash), 'websites')
	})

	test('shows an unavailable route for unknown or malformed hashes', () => {
		assert.equal(getManagementPageFromHash('#unknown'), undefined)
		assert.equal(getManagementPageFromHash('#origin:'), undefined)
		assert.equal(getManagementPageFromHash('#simulation-stack-target=invalid'), undefined)
		assert.equal(getManagementPageFromHash(''), 'home')
		assert.equal(getManagementPageFromHash('#'), 'home')
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

	test('mounts only the initial data view and retains views after their first selection', () => {
		const initialPages = createMountedManagementPages('home')
		assert.deepEqual(initialPages, { home: true, websites: false, 'address-book': false, 'simulation-stack': false, diagnostics: false, settings: false })

		const withWebsites = mountManagementPage(initialPages, 'websites')
		const withAddressBook = mountManagementPage(withWebsites, 'address-book')
		assert.deepEqual(withAddressBook, { home: true, websites: true, 'address-book': true, 'simulation-stack': false, diagnostics: false, settings: false })

		const withSimulationStack = mountManagementPage(withAddressBook, 'simulation-stack')
		const withDiagnostics = mountManagementPage(withSimulationStack, 'diagnostics')

		const withSettings = mountManagementPage(withDiagnostics, 'settings')
		assert.deepEqual(withSettings, { home: true, websites: true, 'address-book': true, 'simulation-stack': true, diagnostics: true, settings: true })
		assert.equal(mountManagementPage(withSettings, 'websites'), withSettings)
		assert.deepEqual(createMountedManagementPages(undefined), { home: false, websites: false, 'address-book': false, 'simulation-stack': false, diagnostics: false, settings: false })
	})

	test('keeps simulation copy feedback available in the embedded stack', () => {
		assert.match(managementViewSource, /<Hint><SimulationStackPage\s*\/><\/Hint>/)
	})
})
