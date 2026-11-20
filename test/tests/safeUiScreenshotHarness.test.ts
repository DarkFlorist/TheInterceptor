import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { parseManagementRoute } from '../../app/ts/utils/managementPages.js'
import { ADDRESS_BOOK_PAGE, getSafeUiExtensionPagePath, SETTINGS_IMPORT_EXPORT_PAGE, SIMULATION_STACK_PAGE } from '../benchmarks/safeUiScreenshotHarness.js'

describe('Safe UI screenshot page targets', () => {
	test('the settings import and export scenario opens the management shell on its settings tab', () => {
		assert.equal(SETTINGS_IMPORT_EXPORT_PAGE.name, 'managementView')
		assert.equal(parseManagementRoute(SETTINGS_IMPORT_EXPORT_PAGE.hash ?? '')?.page, 'settings')
		assert.equal(getSafeUiExtensionPagePath(SETTINGS_IMPORT_EXPORT_PAGE, 3), 'html3/managementViewV3.html#settings')
		assert.equal(getSafeUiExtensionPagePath(SETTINGS_IMPORT_EXPORT_PAGE, 2), 'html/managementView.html#settings')
	})

	test('address book and simulation stack scenarios open their management shell tabs', () => {
		assert.equal(getSafeUiExtensionPagePath(ADDRESS_BOOK_PAGE, 3), 'html3/managementViewV3.html#address-book')
		assert.equal(getSafeUiExtensionPagePath(SIMULATION_STACK_PAGE, 3), 'html3/managementViewV3.html#simulation-stack')
	})

	test('popup-style pages keep their hashless manifest-specific paths', () => {
		assert.equal(getSafeUiExtensionPagePath('popup', 3), 'html3/popupV3.html')
		assert.equal(getSafeUiExtensionPagePath('confirmTransaction', 2), 'html/confirmTransaction.html')
	})
})
