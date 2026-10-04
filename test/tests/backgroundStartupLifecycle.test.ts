import * as assert from 'assert'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import { initializeContentScriptConnectionAfterBackgroundStartup, isIgnorablePortLifecycleError, tryRegisterContentScriptPortListeners } from '../../app/ts/background/contentScriptPortLifecycle.js'

const backgroundStartupSourcePath = path.join(import.meta.dir, '..', '..', 'app', 'ts', 'background', 'background-startup.ts')

describe('background startup lifecycle', () => {
	test('ignores invalidated connect ports before listeners can be attached', () => {
		let disconnectHandlerRan = false
		let messageHandlerRan = false

		const port = {
			get onDisconnect() {
				throw new Error('Failed to read the \'onDisconnect\' property from \'Object\': Extension context invalidated.')
			},
			onMessage: {
				addListener: () => {
					messageHandlerRan = true
				},
			},
		} as unknown as browser.runtime.Port

		const registered = tryRegisterContentScriptPortListeners(
			port,
			() => {
				disconnectHandlerRan = true
			},
			() => {
				messageHandlerRan = true
			},
			() => undefined,
		)

		assert.equal(registered, false)
		assert.equal(disconnectHandlerRan, false)
		assert.equal(messageHandlerRan, false)
	})

	test('classifies extension context invalidation as an ignorable lifecycle error', () => {
		assert.equal(
			isIgnorablePortLifecycleError(new Error('Failed to read the \'onDisconnect\' property from \'Object\': Extension context invalidated.')),
			true,
		)
	})

	test('delays content script connection initialization until background startup completes', async () => {
		let finishStartup: ((value: { ready: true }) => void) | undefined
		const startupPromise = new Promise<{ ready: true }>((resolve) => { finishStartup = resolve })
		let connectionInitialized = false

		const initializationPromise = initializeContentScriptConnectionAfterBackgroundStartup(
			async () => await startupPromise,
			async () => { connectionInitialized = true },
		)
		await Promise.resolve()
		assert.equal(connectionInitialized, false)

		finishStartup?.({ ready: true })

		assert.deepEqual(await initializationPromise, { ready: true })
		assert.equal(connectionInitialized, true)
	})

	test('keeps the real content script registration and first tab-state write behind the startup gate', async () => {
		const source = await Bun.file(backgroundStartupSourcePath).text()
		const connectionHandlerStart = source.indexOf('async function onContentScriptConnected')
		const connectionHandlerEnd = source.indexOf('async function newBlockAttemptCallback', connectionHandlerStart)
		assert.notEqual(connectionHandlerStart, -1)
		assert.notEqual(connectionHandlerEnd, -1)
		const connectionHandler = source.slice(connectionHandlerStart, connectionHandlerEnd)

		const listenerRegistration = connectionHandler.indexOf('tryRegisterContentScriptPortListeners(')
		const startupGate = connectionHandler.indexOf('connectionInitializationPromise = initializeContentScriptConnectionAfterBackgroundStartup(')
		const connectionRegistration = connectionHandler.indexOf('registerWebsiteConnectionAndProvisionallyClaimSignerState(')
		const firstTabStateWrite = connectionHandler.indexOf('await updateTabState(')

		assert.equal(listenerRegistration >= 0 && listenerRegistration < startupGate, true)
		assert.equal(startupGate < connectionRegistration && connectionRegistration < firstTabStateWrite, true)
	})
})
