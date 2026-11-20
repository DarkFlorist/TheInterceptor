import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getManagementPageFromHash } from '../../app/ts/utils/managementPages.js'
import { getSafeUiExtensionPagePath, SETTINGS_IMPORT_EXPORT_PAGE } from '../benchmarks/safeUiScreenshotHarness.js'

describe('Safe UI screenshot page targets', () => {
	test('the settings import and export scenario opens the management shell on its settings tab', () => {
		assert.equal(SETTINGS_IMPORT_EXPORT_PAGE.name, 'managementView')
		assert.equal(getManagementPageFromHash(SETTINGS_IMPORT_EXPORT_PAGE.hash ?? ''), 'settings')
		assert.equal(getSafeUiExtensionPagePath(SETTINGS_IMPORT_EXPORT_PAGE, 3), 'html3/managementViewV3.html#settings')
		assert.equal(getSafeUiExtensionPagePath(SETTINGS_IMPORT_EXPORT_PAGE, 2), 'html/managementView.html#settings')
	})

	test('standalone pages keep their hashless manifest-specific paths', () => {
		assert.equal(getSafeUiExtensionPagePath('addressBook', 3), 'html3/addressBookV3.html')
		assert.equal(getSafeUiExtensionPagePath('confirmTransaction', 2), 'html/confirmTransaction.html')
	})
})
