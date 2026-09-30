import * as assert from 'assert'
import { test } from 'bun:test'
import { requestSafeAppConnection } from '../../app/ts/utils/pageScripts/requestSafeAppConnection.js'
import { prepareSafeAppTab } from '../../app/ts/background/prepareSafeApp.js'
import { requestPopupPrepareSafeApp } from '../../app/ts/background/backgroundUtils.js'
import { PopupMessageReplyRequests, PopupReplyOption } from '../../app/ts/types/interceptor-reply-messages.js'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'

// Reconstruct exactly the function Chrome serializes, without the module's imports or lexical bindings.
const serializedRequest: unknown = Function(`return (${ requestSafeAppConnection.toString() })`)()
if (typeof serializedRequest !== 'function') throw new Error('Serialized Safe connection request must be callable.')

for (const approved of [true, false]) {
	test(`connection preparation ${ approved ? 'completes approval' : 'surfaces rejection' } through the same-window bridge`, async () => {
		const { fakeWindow, origin, emitMessage, restoreGlobals } = createSafeHostHarness()
		try {
			fakeWindow.addEventListener('message', (event) => {
				if (!('data' in event)) return
				const request: unknown = event.data
				if (typeof request !== 'object' || request === null || !('method' in request) || request.method !== 'getSafeInfo' || !('id' in request)) return
				emitMessage({ id: request.id, success: !approved }, 'https://unrelated.example')
				emitMessage({ id: request.id, success: approved, error: 'User rejected access.' })
			})
			assert.deepEqual(await serializedRequest(origin), approved ? { success: true } : { success: false, error: 'User rejected access.' })
		} finally { restoreGlobals() }
	})
}

test('connection preparation times out and never requests access on a navigated page', async () => {
	const { origin, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const pending: Promise<unknown> = serializedRequest(origin)
		fireTimeouts(5 * 60_000)
		assert.deepEqual(await pending, { success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' })
		assert.deepEqual(await serializedRequest('https://other.example'), { success: false, error: 'The website navigated before connecting.' })
	} finally { restoreGlobals() }
})

test('preparation enforces opt-in, targets one top-level origin, and reloads only after success', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let optedIn = true
	let simulationMode = false
	let access: boolean | undefined
	let interceptorDisabled = false
	let navigationOrigin = 'https://safe-app.example'
	let approved = true
	let requests = 0
	let reloads = 0
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { getManifest: () => ({ manifest_version: 3 }) },
		storage: { local: { get: async () => ({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: optedIn ? ['https://safe-app.example'] : [], simulationMode, websiteAccess: [{ website: { websiteOrigin: 'safe-app.example', title: undefined, icon: undefined }, addressAccess: [], access, interceptorDisabled }], activeSigningSafeAddress: '0x1234567890123456789012345678901234567890' }) } },
		tabs: {
			query: async () => [{ id: 1, url: 'chrome-extension://test/settings.html' }, { id: 2, url: 'https://safe-app.example:8443/' }, { id: 3, url: 'https://safe-app.example/app' }],
			get: async () => ({ url: navigationOrigin }),
			reload: async (id: number) => { assert.equal(id, 3); reloads++ },
		},
		scripting: { executeScript: async (injection: { target: { tabId: number, frameIds: number[] }, world: string, args: string[] }) => {
			assert.deepEqual(injection.target, { tabId: 3, frameIds: [0] })
			assert.equal(injection.world, 'MAIN')
			assert.deepEqual(injection.args, ['https://safe-app.example'])
			requests++
			return [{ result: { success: approved, error: 'Rejected.' } }]
		} },
	} })
	try {
		assert.deepEqual(await prepareSafeAppTab('https://safe-app.example'), { success: true })
		assert.equal(reloads, 1)
		optedIn = false
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /add this website/)
		optedIn = true
		simulationMode = true
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /signing mode/)
		simulationMode = false
		interceptorDisabled = true
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /Enable Interceptor/)
		interceptorDisabled = false
		access = false
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /Website Access/)
		access = undefined
		approved = false
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /Rejected/)
		approved = true
		navigationOrigin = 'https://other.example'
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /navigated/)
		assert.equal(requests, 3)
		assert.equal(reloads, 1)
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})

test('popup preparation uses typed request/reply messages and surfaces background failures', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let response: unknown = { method: 'popup_prepareSafeApp', data: { success: true } }
	let calls = 0
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { sendMessage: async (message: unknown) => {
			assert.deepEqual(PopupMessageReplyRequests.parse(message), { method: 'popup_prepareSafeApp', data: { origin: 'https://safe-app.example' } })
			calls++
			return response
		} },
	} })
	try {
		await requestPopupPrepareSafeApp('https://safe-app.example')
		response = PopupReplyOption.serialize({ method: 'popup_prepareSafeApp', data: { success: false, errorMessage: 'Select a Safe first.' } })
		await assert.rejects(requestPopupPrepareSafeApp('https://safe-app.example'), /Select a Safe first/)
		response = undefined
		await assert.rejects(requestPopupPrepareSafeApp('https://safe-app.example'), /did not return a reply/)
		assert.equal(calls, 3)
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
