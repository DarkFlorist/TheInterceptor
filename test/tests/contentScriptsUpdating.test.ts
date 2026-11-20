import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { withSilencedConsole } from './consoleSilence.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'

// The manifest v2 registration is covered by contentScriptsRegistrationManifestV2.test.ts.
type ContentScriptBrowserMockOptions = {
	readonly registerError?: Error
	readonly updateError?: Error
	readonly registeredContentScriptIds?: readonly string[]
}

const installBrowserMock = createPerTestBrowserMockInstaller()

async function installContentScriptBrowserMock({ registerError, updateError, registeredContentScriptIds = [] }: ContentScriptBrowserMockOptions = {}) {
	const browserMock = installBrowserMock()
	const { browser, calls } = browserMock
	if (registeredContentScriptIds.length > 0) await browser.scripting.registerContentScripts(registeredContentScriptIds.map((id) => ({ id })))

	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const { registerContentScripts, updateContentScripts, unregisterContentScripts, getRegisteredContentScripts } = browser.scripting
	browser.scripting.registerContentScripts = async (scripts) => {
		scriptingOperations.push('register')
		if (registerError !== undefined) throw registerError
		await registerContentScripts(scripts)
	}
	browser.scripting.updateContentScripts = async (scripts) => {
		scriptingOperations.push('update')
		if (updateError !== undefined) throw updateError
		await updateContentScripts(scripts)
	}
	browser.scripting.unregisterContentScripts = async (filter) => {
		scriptingOperations.push('unregister')
		unregisteredContentScriptIdBatches.push([...filter?.ids ?? (await getRegisteredContentScripts()).map(({ id }) => id)])
		await unregisterContentScripts(filter)
	}

	return {
		sentMessages: calls.runtimeSendMessage,
		getRegisteredContentScripts: browserMock.getRegisteredContentScripts,
		getScriptingOperations() { return [...scriptingOperations] },
		getUnregisteredContentScriptIdBatches() { return unregisteredContentScriptIdBatches.map((ids) => [...ids]) },
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/utils/unexpectedErrorStorage.js'),
	}
}

describe('content script injection strategy', () => {
	test('creates valid manifest v3 exclusions without admitting malformed stored origins', async () => {
		await installContentScriptBrowserMock()
		const { getManifestV3ExcludeMatches } = await loadModules()

		assert.deepEqual(getManifestV3ExcludeMatches([
			'',
			'example.com',
			'localhost:3000',
			'127.0.0.1:8545',
			'[::1]:8545',
			'https://secure.example',
			'https://localhost:4443',
			'https://invalid.example/path',
		]), [
			'file:///*',
			'*://*.example.com/*',
			'http://localhost:3000/*',
			'https://localhost:3000/*',
			'http://127.0.0.1:8545/*',
			'https://127.0.0.1:8545/*',
			'http://[::1]:8545/*',
			'https://[::1]:8545/*',
			'https://*.secure.example/*',
			'https://localhost:4443/*',
		])
	})

	test('records manifest v3 registration failures as unexpected errors', async () => {
		const { sentMessages } = await installContentScriptBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV3())

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'registration failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_registration_failed')
		assert.equal(getMessageMethod(sentMessages.at(-1)), 'popup_UnexpectedErrorOccured')
	})

	test('registers missing scripts, updates existing definitions, and then prunes obsolete registrations', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = await installContentScriptBrowserMock({ registeredContentScriptIds: ['inpage', 'obsolete-inpage'] })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV3()

		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getScriptingOperations(), ['register', 'update', 'unregister'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['obsolete-inpage']])
	})

	test('keeps existing and obsolete manifest v3 content scripts registered when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = await installContentScriptBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV3())

		assert.deepEqual(getScriptingOperations(), ['update'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [])
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'obsolete-inpage'])
	})
})
