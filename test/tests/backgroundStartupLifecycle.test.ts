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

	// Background startup cannot be loaded in a unit test, so this checks only the wiring; the gate is tested above and everything after it in registerWebsiteConnection, in backgroundSignerLifecycle.
	test('keeps the real content script registration behind the startup gate', async () => {
		const source = await Bun.file(backgroundStartupSourcePath).text()
		const connectionHandlerStart = source.indexOf('async function onContentScriptConnected')
		const connectionHandlerEnd = source.indexOf('async function newBlockAttemptCallback', connectionHandlerStart)
		assert.notEqual(connectionHandlerStart, -1)
		assert.notEqual(connectionHandlerEnd, -1)
		const connectionHandler = source.slice(connectionHandlerStart, connectionHandlerEnd)

		const listenerRegistration = connectionHandler.indexOf('tryRegisterContentScriptPortListeners(')
		const startupGate = connectionHandler.indexOf('connectionInitializationPromise = initializeContentScriptConnectionAfterBackgroundStartup(')
		const connectionRegistration = connectionHandler.indexOf('registerWebsiteConnection(')

		assert.equal(listenerRegistration >= 0 && listenerRegistration < startupGate, true)
		assert.equal(startupGate < connectionRegistration, true)
	})

	// The behaviour of the advance is tested in the Safe signer routing suite; background startup cannot be loaded in a unit test, so this checks only that every new block runs it, with no connection-status condition.
	test('advances outstanding Gnosis Safe signer-reply work on every new block', async () => {
		const source = await Bun.file(backgroundStartupSourcePath).text()
		const callbackStart = source.indexOf('async function newBlockAttemptCallback')
		const callbackEnd = source.indexOf('async function onErrorBlockCallback', callbackStart)
		assert.notEqual(callbackStart, -1)
		assert.notEqual(callbackEnd, -1)
		const callback = source.slice(callbackStart, callbackEnd)
		assert.equal(callback.includes('if (isNewBlock) void catchAllErrorsAndCall(async () => await advanceOutstandingSafeSignerReplies(getSimulationServices(), websiteTabConnections))'), true)
		assert.equal(callback.includes('getRpcConnectionStatus'), false)
	})
})
