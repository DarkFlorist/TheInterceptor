import * as assert from 'assert'
import { test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { requestSafeAppConnection } from '../../app/inpage/ts/requestSafeAppConnection.js'
import { prepareSafeAppTab, cancelSafeAppPreparation } from '../../app/ts/background/prepareSafeApp.js'
import { requestPopupPrepareSafeApp, requestPopupCancelPrepareSafeApp } from '../../app/ts/background/backgroundUtils.js'
import { PopupMessageReplyRequests, PopupReplyOption } from '../../app/ts/types/interceptor-reply-messages.js'
import { SAFE_APPS_PREPARATION_TIMEOUT_MS, SAFE_APPS_PREPARATION_CANCEL_EVENT, SAFE_APPS_PREPARATION_CANCEL_MARKER } from '../../app/inpage/ts/safeAppsProtocol.js'
import { contentScriptRegistration } from '../../app/ts/background/contentScriptRegistration.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'

function createRegistrationMock(origin: string, beforeRegister?: () => Promise<void>, initiallyRegistered = true) {
	const scripts = new Map<string, { readonly id: string, readonly matches: readonly string[] }>()
	if (initiallyRegistered) scripts.set('safe-apps-host', { id: 'safe-apps-host', matches: [`${ origin }:443/*`] })
	return {
		getRegisteredContentScripts: async () => [...scripts.values()],
		registerContentScripts: async (next: readonly { readonly id: string, readonly matches: readonly string[] }[]) => {
			await beforeRegister?.()
			for (const script of next) scripts.set(script.id, script)
		},
		updateContentScripts: async (next: readonly { readonly id: string, readonly matches: readonly string[] }[]) => { for (const script of next) scripts.set(script.id, script) },
		unregisterContentScripts: async ({ ids }: { readonly ids: readonly string[] }) => { for (const id of ids) scripts.delete(id) },
	}
}

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
			assert.deepEqual(await requestSafeAppConnection(origin), approved ? { success: true } : { success: false, error: 'User rejected access.' })
		} finally { restoreGlobals() }
	})
}

test('connection preparation times out and never requests access on a navigated page', async () => {
	const { origin, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const pending: Promise<unknown> = requestSafeAppConnection(origin)
		fireTimeouts(SAFE_APPS_PREPARATION_TIMEOUT_MS)
		assert.deepEqual(await pending, { success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' })
		assert.deepEqual(await requestSafeAppConnection('https://other.example'), { success: false, error: 'The website navigated before connecting.' })
	} finally { restoreGlobals() }
})

test('preparation enforces opt-in, targets one top-level origin, and reloads only after success', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let optedIn = true
	let simulationMode = false
	let access: boolean | undefined
	let interceptorDisabled = false
	let navigationOrigin = 'https://safe-app.example'
	let frameOrigin = 'https://safe-app.example'
	let documentId: string | undefined = 'document-3'
	let navigateDuringRequest = false
	let approved = true
	let requests = 0
	let reloads = 0
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { getManifest: () => ({ manifest_version: 3 }) },
		storage: { local: { get: async () => ({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: optedIn ? ['https://safe-app.example'] : [], simulationMode, websiteAccess: [{ website: { websiteOrigin: 'safe-app.example', title: undefined, icon: undefined }, addressAccess: [], access, interceptorDisabled }], activeSigningSafeAddress: '0x1234567890123456789012345678901234567890' }) } },
		tabs: {
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			query: async () => [{ id: 1, url: 'chrome-extension://test/settings.html' }, { id: 2, url: 'https://safe-app.example:8443/' }, { id: 3, url: 'https://safe-app.example/app' }],
			get: async () => ({ url: navigationOrigin }),
			reload: async (id: number) => { assert.equal(id, 3); reloads++ },
		},
		scripting: { ...createRegistrationMock('https://safe-app.example'), executeScript: async (injection: { target: { tabId: number, documentIds?: string[], frameIds?: number[] }, world: string, files: string[] }) => {
			if (injection.world === 'ISOLATED') {
				assert.deepEqual(injection.target, { tabId: 3, frameIds: [0] })
				assert.deepEqual(injection.files, ['/inpage/js/readDocumentOrigin.js'])
				return [{ result: frameOrigin, documentId }]
			}
			assert.deepEqual(injection.target, { tabId: 3, documentIds: ['document-3'] })
			assert.equal(injection.world, 'MAIN')
			assert.deepEqual(injection.files, ['/inpage/js/prepareSafeAppBootstrap.js'])
			requests++
			// A successful real probe finishes ordinary website approval before returning.
			if (approved) access = true
			if (navigateDuringRequest) navigationOrigin = 'https://other.example'
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
		frameOrigin = 'https://other.example'
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /navigated/)
		assert.equal(requests, 2)
		frameOrigin = 'https://safe-app.example'
		documentId = undefined
		assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /does not support/)
		assert.equal(requests, 2)
		documentId = 'document-3'
		navigateDuringRequest = true
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

// Run the built file as a classic script: its imported protocol helpers must be present and its final value must remain awaitable.
test('compiled preparation entrypoint returns the bridge reply without background function serialization', async () => {
	const build = await Bun.build({ entrypoints: ['app/inpage/ts/prepareSafeAppBootstrap.ts', 'app/inpage/ts/readDocumentOrigin.ts', 'app/inpage/ts/cancelSafeAppPreparationBootstrap.ts', 'app/inpage/ts/clearSafeAppPreparationCancellationBootstrap.ts'], target: 'browser', format: 'esm' })
	assert.equal(build.success, true)
	const output = build.outputs.find(({ path }) => path.endsWith('/prepareSafeAppBootstrap.js'))
	const originOutput = build.outputs.find(({ path }) => path.endsWith('/readDocumentOrigin.js'))
	const cancelOutput = build.outputs.find(({ path }) => path.endsWith('/cancelSafeAppPreparationBootstrap.js'))
	const clearOutput = build.outputs.find(({ path }) => path.endsWith('/clearSafeAppPreparationCancellationBootstrap.js'))
	assert.ok(originOutput)
	assert.ok(cancelOutput)
	assert.ok(clearOutput)
	const originSource = await originOutput.text()
	const cancelSource = await cancelOutput.text()
	const clearSource = await clearOutput.text()
	assert.ok(output)
	const source = await output.text()
	for (const approved of [true, false]) {
		const { fakeWindow, emitMessage, restoreGlobals } = createSafeHostHarness()
		try {
			fakeWindow.addEventListener('message', (event) => {
				if (!('data' in event)) return
				const request: unknown = event.data
				if (typeof request !== 'object' || request === null || !('method' in request) || request.method !== 'getSafeInfo' || !('id' in request)) return
				emitMessage({ id: request.id, success: approved, error: 'Rejected.' })
			})
			assert.equal(runInNewContext(originSource, { window: fakeWindow }), 'https://app.request.finance')
			const pending: unknown = runInNewContext(source, { window: fakeWindow, crypto })
			assert.deepEqual(await pending, approved ? { success: true } : { success: false, error: 'Rejected.' })
		} finally { restoreGlobals() }
	}
	const { fakeWindow, restoreGlobals } = createSafeHostHarness()
	try {
		let requests = 0
		fakeWindow.addEventListener('message', () => { requests++ })
		runInNewContext(cancelSource, { window: fakeWindow, Event })
		const cancelled: unknown = runInNewContext(source, { window: fakeWindow, crypto })
		assert.deepEqual(await cancelled, { success: false, error: 'Safe connection was cancelled.' })
		assert.equal(requests, 0)
		runInNewContext(clearSource, { window: fakeWindow })
		assert.equal(Reflect.get(fakeWindow, SAFE_APPS_PREPARATION_CANCEL_MARKER), undefined)
	} finally { restoreGlobals() }
})

test('page preparation cancellation settles immediately and clears the probe timer', async () => {
	const { fakeWindow, origin, activeTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const pending = requestSafeAppConnection(origin)
		assert.deepEqual(activeTimeouts(), [SAFE_APPS_PREPARATION_TIMEOUT_MS])
		fakeWindow.dispatchEvent(new Event(SAFE_APPS_PREPARATION_CANCEL_EVENT))
		assert.deepEqual(await pending, { success: false, error: 'Safe connection was cancelled.' })
		assert.deepEqual(activeTimeouts(), [])
	} finally { restoreGlobals() }
})

test('a cancellation that executes before page preparation prevents the Safe access request', async () => {
	const { fakeWindow, origin, activeTimeouts, restoreGlobals } = createSafeHostHarness()
	let requests = 0
	try {
		fakeWindow.addEventListener('message', () => { requests++ })
		Reflect.set(fakeWindow, SAFE_APPS_PREPARATION_CANCEL_MARKER, true)
		assert.deepEqual(await requestSafeAppConnection(origin), { success: false, error: 'Safe connection was cancelled.' })
		assert.equal(requests, 0)
		assert.deepEqual(activeTimeouts(), [])
	} finally { restoreGlobals() }
})

test('background cancellation waits for a delayed prepare script before releasing the document', async () => {
	const { fakeWindow, origin, restoreGlobals } = createSafeHostHarness({ origin: 'https://delayed-preparation.example' })
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let releasePrepareScript: (() => void) | undefined
	let markPrepareQueued: (() => void) | undefined
	let markCancelInjected: (() => void) | undefined
	const prepareQueued = new Promise<void>((resolve) => { markPrepareQueued = resolve })
	const cancelInjected = new Promise<void>((resolve) => { markCancelInjected = resolve })
	let requests = 0
	let markerCleared = false
	fakeWindow.addEventListener('message', () => { requests++ })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { getManifest: () => ({ manifest_version: 3 }), sendMessage: async () => undefined },
		storage: { local: { get: async () => ({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: [origin], simulationMode: false, activeSigningSafeAddress: '0x1234567890123456789012345678901234567890', websiteAccess: [{ website: { websiteOrigin: new URL(origin).host }, addressAccess: [], access: true }] }) } },
		tabs: {
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			query: async () => [{ id: 7, url: origin }],
			get: async () => ({ url: origin }),
			reload: async () => { throw new Error('Cancelled preparation must not reload the tab.') },
		},
		scripting: { ...createRegistrationMock(origin), executeScript: async (injection: { readonly world: string, readonly files: readonly string[] }) => {
			if (injection.world === 'ISOLATED') return [{ result: origin, documentId: 'delayed-document' }]
			if (injection.files[0] === '/inpage/js/prepareSafeAppBootstrap.js') {
				markPrepareQueued?.()
				await new Promise<void>((resolve) => { releasePrepareScript = resolve })
				return [{ result: await requestSafeAppConnection(origin) }]
			}
			if (injection.files[0] === '/inpage/js/cancelSafeAppPreparationBootstrap.js') {
				Reflect.set(fakeWindow, SAFE_APPS_PREPARATION_CANCEL_MARKER, true)
				fakeWindow.dispatchEvent(new Event(SAFE_APPS_PREPARATION_CANCEL_EVENT))
				markCancelInjected?.()
				return []
			}
			if (injection.files[0] === '/inpage/js/clearSafeAppPreparationCancellationBootstrap.js') {
				Reflect.deleteProperty(fakeWindow, SAFE_APPS_PREPARATION_CANCEL_MARKER)
				markerCleared = true
				return []
			}
			throw new Error('Unexpected injected script.')
		} },
	} })
	try {
		const pending = prepareSafeAppTab(origin)
		await prepareQueued
		const cancellation = cancelSafeAppPreparation(origin)
		await cancelInjected
		assert.equal(requests, 0)
		releasePrepareScript?.()
		await cancellation
		assert.match(JSON.stringify(await pending), /cancelled/)
		assert.equal(requests, 0)
		assert.equal(markerCleared, true)
	} finally {
		releasePrepareScript?.()
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		restoreGlobals()
	}
})

for (const action of ['cancel', 'close', 'get-error', 'reload-error', 'unexpected-error']) {
	test(`background preparation returns typed failures for ${ action } and releases its operation/listener`, async () => {
		const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
		const listeners = new Set<(tabId: number) => void>()
		let started = false
		let reloads = 0
		let cleanupStarted = false
		let markerCleared = false
		let completeCleanup: (() => void) | undefined
		let completePreparation: (() => void) | undefined
		const cleanup = new Promise<void>((resolve) => { completeCleanup = resolve })
		const pageScript = new Promise<unknown>((resolve) => { completePreparation = () => resolve([{ result: { success: false, error: 'Safe connection was cancelled.' } }]) })
		Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
			runtime: { getManifest: () => ({ manifest_version: 3 }) },
			storage: { local: { get: async () => ({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://safe-app.example'], simulationMode: false, activeSigningSafeAddress: '0x1234567890123456789012345678901234567890', websiteAccess: [{ website: { websiteOrigin: 'safe-app.example' }, addressAccess: [], access: true }] }) } },
			tabs: {
				onRemoved: { addListener: (listener: (tabId: number) => void) => listeners.add(listener), removeListener: (listener: (tabId: number) => void) => listeners.delete(listener) },
				query: async () => [{ id: 1, url: 'https://safe-app.example' }],
				get: async () => { if (action === 'get-error') throw new Error('No tab with id: 1.'); return { url: 'https://safe-app.example' } },
				reload: async () => { if (action === 'reload-error') throw new Error('No tab with id: 1.'); reloads++ },
			},
			scripting: { ...createRegistrationMock('https://safe-app.example'), executeScript: async (injection: { world: string, files: string[] }) => {
				if (injection.world === 'ISOLATED') return [{ result: 'https://safe-app.example', documentId: 'doc-1' }]
				if (injection.files[0] === '/inpage/js/cancelSafeAppPreparationBootstrap.js') { cleanupStarted = true; await cleanup; completePreparation?.(); return [] }
				if (injection.files[0] === '/inpage/js/clearSafeAppPreparationCancellationBootstrap.js') { markerCleared = true; return [] }
				started = true
				if (action === 'unexpected-error') throw new Error('Unexpected browser failure')
				if (action === 'get-error' || action === 'reload-error') return [{ result: { success: true } }]
				return await pageScript
			} },
		} })
		try {
			const pending = prepareSafeAppTab('https://safe-app.example')
			if (action === 'unexpected-error') await assert.rejects(pending, /Unexpected browser failure/)
			else if (action === 'get-error' || action === 'reload-error') assert.match(JSON.stringify(await pending), /tab closed or navigated/)
			else {
				while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
				assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /already running/)
				if (action === 'cancel') {
					const cancellation = cancelSafeAppPreparation('https://safe-app.example')
					while (!cleanupStarted) await new Promise((resolve) => setTimeout(resolve, 0))
					assert.match(JSON.stringify(await prepareSafeAppTab('https://safe-app.example')), /already running/)
					completeCleanup?.()
					await cancellation
				} else for (const listener of listeners) listener(1)
				assert.match(JSON.stringify(await pending), action === 'cancel' ? /cancelled/ : /tab was closed/)
			}
			assert.equal(listeners.size, 0)
			assert.equal(reloads, 0)
			if (action === 'cancel') assert.equal(markerCleared, true)
		} finally {
			if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
			else Object.defineProperty(globalThis, 'browser', previousBrowser)
		}
	})
}

test('popup preparation cancellation uses the typed Safe protocol', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async (request: unknown) => {
		assert.deepEqual(PopupMessageReplyRequests.parse(request), { method: 'popup_cancelPrepareSafeApp', data: { origin: 'https://safe-app.example' } })
		return PopupReplyOption.serialize({ method: 'popup_cancelPrepareSafeApp', data: { success: true } })
	} } } })
	try { await requestPopupCancelPrepareSafeApp('https://safe-app.example') } finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})

for (const outcome of ['registered', 'recovered', 'removed', 'cancelled', 'access-revoked', 'access-removed', 'disabled', 'unexpected-error']) {
	test(`preparation waits for queued registration and reloads only a registered host (${ outcome })`, async () => {
		const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
		const origin = `https://registration-${ outcome }.example`
		let releaseRegistration: (() => void) | undefined
		const registrationBarrier = new Promise<void>((resolve) => { releaseRegistration = resolve })
		let registering = false
		let reloads = 0
		let prepared = false
		let optedIn = true
		let blockAccess = false
		let accessRemoved = false
		const registration = createRegistrationMock(origin, async () => {
			registering = true
			await registrationBarrier
			if (outcome === 'unexpected-error') throw new Error('Unexpected registration failure')
		}, false)
		Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
			runtime: { getManifest: () => ({ manifest_version: 3 }), sendMessage: async () => undefined },
			storage: { local: {
				get: async () => ({
					safeAppsCompatibilityMode: true,
					safeAppsHostOrigins: optedIn ? [origin] : [],
					simulationMode: false,
					activeSigningSafeAddress: '0x1234567890123456789012345678901234567890',
					websiteAccess: accessRemoved ? [] : [{ website: { websiteOrigin: new URL(origin).host }, addressAccess: [], access: !blockAccess || outcome !== 'access-revoked', interceptorDisabled: blockAccess && outcome === 'disabled' }],
				}),
				set: async () => undefined,
			} },
			tabs: {
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
				query: async () => [{ id: 1, url: origin }],
				get: async () => ({ url: origin }),
				reload: async () => { reloads++ },
			},
			scripting: {
				...registration,
				registerContentScripts: async (scripts: readonly { readonly id: string, readonly matches: readonly string[] }[]) => {
					if (outcome === 'recovered' && scripts.some(({ id }) => id === 'safe-apps-host')) {
						registering = true
						await registrationBarrier
						throw new Error('Host registration failed')
					}
					await registration.registerContentScripts(scripts)
				},
				executeScript: async ({ world }: { readonly world: string }) => {
					if (world === 'ISOLATED') return [{ result: origin, documentId: 'doc-race' }]
					prepared = true
					return [{ result: { success: true } }]
				},
			},
		} })
		try {
			await withSilencedConsole(async () => {
				const queuedUpdate = contentScriptRegistration.update()
				// Attach rejection handling before releasing the intentionally failing registration.
				const updateResult = queuedUpdate.then(() => undefined, (error: unknown) => error)
				while (!registering) await new Promise((resolve) => setTimeout(resolve, 0))
				const preparation = prepareSafeAppTab(origin)
				const preparationResult = preparation.then((reply) => reply, (error: unknown) => error)
				while (!prepared) await new Promise((resolve) => setTimeout(resolve, 0))
				await new Promise((resolve) => setTimeout(resolve, 0))
				assert.equal(reloads, 0)
				if (outcome === 'removed') optedIn = false
				if (outcome === 'access-revoked' || outcome === 'disabled') blockAccess = true
				if (outcome === 'access-removed') accessRemoved = true
				if (outcome === 'cancelled') {
					await cancelSafeAppPreparation(origin)
					assert.match(JSON.stringify(await preparationResult), /cancelled/)
				}
				releaseRegistration?.()
				const reply = await preparationResult
				await updateResult
				if (outcome === 'registered') {
					assert.deepEqual(reply, { success: true })
					assert.equal(reloads, 1)
				} else {
				if (outcome === 'unexpected-error') assert.match(reply instanceof Error ? reply.message : '', /Unexpected registration failure/)
					else if (outcome === 'access-revoked' || outcome === 'access-removed') assert.match(JSON.stringify(reply), /Website Access/)
					else if (outcome === 'disabled') assert.match(JSON.stringify(reply), /Enable Interceptor/)
					else assert.match(JSON.stringify(reply), outcome === 'cancelled' ? /cancelled/ : /could not be registered/)
					assert.equal(reloads, 0)
				}
			})
		} finally {
			releaseRegistration?.()
			if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
			else Object.defineProperty(globalThis, 'browser', previousBrowser)
		}
	})
}

test('preparation retries recovered host registration without changing persisted settings', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const origin = 'https://registration-retry.example'
	let hostFails = true
	let hostAttempts = 0
	let reloads = 0
	const registration = createRegistrationMock(origin, undefined, false)
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { getManifest: () => ({ manifest_version: 3 }), sendMessage: async () => undefined },
		storage: { local: {
			get: async () => ({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: [origin], simulationMode: false, activeSigningSafeAddress: '0x1234567890123456789012345678901234567890', websiteAccess: [{ website: { websiteOrigin: new URL(origin).host }, addressAccess: [], access: true }] }),
			set: async () => undefined,
		} },
		tabs: {
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			query: async () => [{ id: 1, url: origin }],
			get: async () => ({ url: origin }),
			reload: async () => { reloads++ },
		},
		scripting: {
			...registration,
			registerContentScripts: async (scripts: readonly { readonly id: string, readonly matches: readonly string[] }[]) => {
				if (scripts.some(({ id }) => id === 'safe-apps-host')) {
					hostAttempts++
					if (hostFails) throw new Error('Transient host registration failure')
				}
				await registration.registerContentScripts(scripts)
			},
			executeScript: async ({ world }: { readonly world: string }) => world === 'ISOLATED' ? [{ result: origin, documentId: 'doc-retry' }] : [{ result: { success: true } }],
		},
	} })
	try {
		await withSilencedConsole(async () => {
			assert.match(JSON.stringify(await prepareSafeAppTab(origin)), /could not be registered/)
			assert.equal(hostAttempts, 1)
			assert.equal(reloads, 0)
			hostFails = false
			assert.deepEqual(await prepareSafeAppTab(origin), { success: true })
			assert.equal(hostAttempts, 2)
			assert.equal(reloads, 1)
		})
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
