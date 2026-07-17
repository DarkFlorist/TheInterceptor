import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createMountedManagementPages, getManagementPageFromHash, getManagementPageFromNavigationKey, getManagementPageHash, getManagementTabTarget, getSimulationStackManagementTabTarget, mountManagementPage } from '../../app/ts/utils/managementPages.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'
import type { TransactionOrMessageIdentifier } from '../../app/ts/types/interceptor-messages.js'

const managementViewSource = await Bun.file(new URL('../../app/ts/components/pages/ManagementView.tsx', import.meta.url)).text()

describe('management view routing', () => {
	test('maps each management tab to a stable hash', () => {
		assert.equal(getManagementPageHash('websites'), '#websites')
		assert.equal(getManagementPageHash('address-book'), '#address-book')
		assert.equal(getManagementPageHash('simulation-stack'), '#simulation-stack')
		assert.equal(getManagementPageHash('diagnostics'), '#diagnostics')
		assert.equal(getManagementPageHash('settings'), '#settings')
	})

	test('routes simulation stack links into the shared management tab', () => {
		const identifier: TransactionOrMessageIdentifier = { type: 'Transaction', transactionIdentifier: 1n }
		const targetHash = getSimulationStackTargetHash(identifier, 'test-focus')

		assert.deepEqual(getSimulationStackManagementTabTarget(), { tabName: 'settingsView', targetHash: '#simulation-stack' })
		assert.equal(getSimulationStackManagementTabTarget(identifier).tabName, 'settingsView')
		assert.equal(getManagementPageFromHash(targetHash), 'simulation-stack')
	})

	test('maps all three popup controls into the shared management navigation', () => {
		assert.deepEqual(getManagementTabTarget('popup_openWebsiteAccess'), { tabName: 'settingsView', targetHash: '#websites' })
		assert.deepEqual(getManagementTabTarget('popup_openAddressBook'), { tabName: 'settingsView', targetHash: '#address-book' })
		assert.deepEqual(getManagementTabTarget('popup_openSettings'), { tabName: 'settingsView', targetHash: '#settings' })
	})

	test('selects management tabs from their hashes', () => {
		assert.equal(getManagementPageFromHash('#websites'), 'websites')
		assert.equal(getManagementPageFromHash('#address-book'), 'address-book')
		assert.equal(getManagementPageFromHash('#simulation-stack'), 'simulation-stack')
		assert.equal(getManagementPageFromHash('#diagnostics'), 'diagnostics')
		assert.equal(getManagementPageFromHash('#settings'), 'settings')
	})

	test('keeps website details in the websites tab and safely defaults unknown hashes', () => {
		assert.equal(getManagementPageFromHash('#origin:https://example.com'), 'websites')
		assert.equal(getManagementPageFromHash('#unknown'), 'websites')
		assert.equal(getManagementPageFromHash(''), 'websites')
	})

	test('supports standard tablist keyboard navigation with wrapping', () => {
		assert.equal(getManagementPageFromNavigationKey('websites', 'ArrowRight'), 'address-book')
		assert.equal(getManagementPageFromNavigationKey('address-book', 'ArrowRight'), 'simulation-stack')
		assert.equal(getManagementPageFromNavigationKey('simulation-stack', 'ArrowRight'), 'diagnostics')
		assert.equal(getManagementPageFromNavigationKey('diagnostics', 'ArrowRight'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('settings', 'ArrowRight'), 'websites')
		assert.equal(getManagementPageFromNavigationKey('websites', 'ArrowLeft'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('settings', 'Home'), 'websites')
		assert.equal(getManagementPageFromNavigationKey('websites', 'End'), 'settings')
		assert.equal(getManagementPageFromNavigationKey('websites', 'Enter'), undefined)
	})

	test('mounts only the initial data view and retains views after their first selection', () => {
		const initialPages = createMountedManagementPages('websites')
		assert.deepEqual(initialPages, { websites: true, 'address-book': false, 'simulation-stack': false, diagnostics: false, settings: false })

		const withAddressBook = mountManagementPage(initialPages, 'address-book')
		assert.deepEqual(withAddressBook, { websites: true, 'address-book': true, 'simulation-stack': false, diagnostics: false, settings: false })

		const withSimulationStack = mountManagementPage(withAddressBook, 'simulation-stack')
		const withDiagnostics = mountManagementPage(withSimulationStack, 'diagnostics')

		const withSettings = mountManagementPage(withDiagnostics, 'settings')
		assert.deepEqual(withSettings, { websites: true, 'address-book': true, 'simulation-stack': true, diagnostics: true, settings: true })
		assert.equal(mountManagementPage(withSettings, 'websites'), withSettings)
	})

	test('keeps simulation copy feedback available in the embedded stack', () => {
		assert.match(managementViewSource, /<Hint><SimulationStackPage\s*\/><\/Hint>/)
	})
})
