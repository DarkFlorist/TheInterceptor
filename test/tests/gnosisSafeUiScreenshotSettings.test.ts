import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'bun:test'
import { getGnosisSafeUiScreenshotSettings } from '../benchmarks/gnosisSafeUiScreenshotSettings.js'

test('the Firefox screenshot package command selects Firefox with its actual environment assignment', async () => {
	const packageJson = await Bun.file(new URL('../../package.json', import.meta.url)).json()
	const command: unknown = packageJson.scripts['screenshots:gnosis-safe-ui:firefox']
	assert.equal(typeof command, 'string')
	if (typeof command !== 'string') throw new Error('Missing Firefox screenshot command')
	const assignment = command.match(/\b([A-Z_]+)=firefox\b/)
	if (assignment?.[1] === undefined) throw new Error('Missing Firefox screenshot environment assignment')
	assert.equal(getGnosisSafeUiScreenshotSettings({ [assignment[1]]: 'firefox' }).browser, 'firefox')
})

test('canonical screenshot overrides select the browser, extension and output directory', () => {
	assert.deepEqual(getGnosisSafeUiScreenshotSettings({
		GNOSIS_SAFE_UI_SCREENSHOT_BROWSER: 'firefox',
		GNOSIS_SAFE_UI_EXTENSION_DIRECTORY: 'custom-extension',
		GNOSIS_SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY: 'custom-screenshots',
	}), { browser: 'firefox', extensionDirectory: 'custom-extension', outputDirectory: path.resolve('custom-screenshots') })
})

test('legacy screenshot overrides remain available and canonical names win', () => {
	const legacy = { SAFE_UI_SCREENSHOT_BROWSER: 'firefox', SAFE_UI_EXTENSION_DIRECTORY: 'legacy-extension', SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY: 'legacy-screenshots' }
	assert.deepEqual(getGnosisSafeUiScreenshotSettings(legacy), { browser: 'firefox', extensionDirectory: 'legacy-extension', outputDirectory: path.resolve('legacy-screenshots') })
	assert.deepEqual(getGnosisSafeUiScreenshotSettings({ ...legacy, GNOSIS_SAFE_UI_SCREENSHOT_BROWSER: 'chromium', GNOSIS_SAFE_UI_EXTENSION_DIRECTORY: 'new-extension', GNOSIS_SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY: 'new-screenshots' }), { browser: 'chromium', extensionDirectory: 'new-extension', outputDirectory: path.resolve('new-screenshots') })
})

test('default screenshot settings preserve Chromium and the temporary output directory', () => {
	assert.deepEqual(getGnosisSafeUiScreenshotSettings({}), { browser: 'chromium', extensionDirectory: undefined, outputDirectory: path.join(tmpdir(), 'interceptor-safe-wallet-screenshots') })
})

test('an unsupported browser names the canonical setting in its error', () => {
	assert.throws(() => getGnosisSafeUiScreenshotSettings({ GNOSIS_SAFE_UI_SCREENSHOT_BROWSER: 'unsupported' }), /Unsupported GNOSIS_SAFE_UI_SCREENSHOT_BROWSER value: unsupported/)
})
