import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'

function replaceGlobal(name: string, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name)
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
	return () => {
		if (previous === undefined) Reflect.deleteProperty(globalThis, name)
		else Object.defineProperty(globalThis, name, previous)
	}
}

test('management tabs reload Diagnostics and release hidden website listeners', async () => {
	const dom = installDomMock()
	const hashListeners = new Set<EventListenerOrEventListenerObject>()
	const runtimeListeners = new Set<(message: unknown) => unknown>()
	let diagnosticsLoads = 0
	let websiteLoads = 0
	let hash = '#home'
	const location = {
		get hash() { return hash },
		set hash(nextHash: string) {
			hash = nextHash
			for (const listener of [...hashListeners]) {
				if (typeof listener === 'function') listener(new Event('hashchange'))
				else listener.handleEvent(new Event('hashchange'))
			}
		},
	}
	const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === 'hashchange') hashListeners.add(listener)
	}
	const removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === 'hashchange') hashListeners.delete(listener)
	}
	const restoreLocation = replaceGlobal('location', location)
	const restoreAddEventListener = replaceGlobal('addEventListener', addEventListener)
	const restoreRemoveEventListener = replaceGlobal('removeEventListener', removeEventListener)
	Object.defineProperty(globalThis.window, 'location', { configurable: true, value: location })
	Object.defineProperty(globalThis.window, 'addEventListener', { configurable: true, value: addEventListener })
	Object.defineProperty(globalThis.window, 'removeEventListener', { configurable: true, value: removeEventListener })
	Object.defineProperty(dom.document, 'getElementById', { configurable: true, value: () => null })
	Object.defineProperty(dom.document, 'querySelector', { configurable: true, value: () => null })
	const restoreBrowser = replaceGlobal('browser', {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			async sendMessage(message: { method: string }) {
				if (message.method === 'popup_requestDiagnostics') {
					diagnosticsLoads += 1
					return { method: 'popup_requestDiagnostics', diagnostics: [] }
				}
				if (message.method === 'popup_retrieveWebsiteAccess') websiteLoads += 1
				return undefined
			},
			onMessage: {
				addListener(listener: (message: unknown) => unknown) { runtimeListeners.add(listener) },
				removeListener(listener: (message: unknown) => unknown) { runtimeListeners.delete(listener) },
			},
		},
	})

	try {
		const { ManagementView } = await import('../../app/ts/components/pages/ManagementView.js')
		await act(() => { render(h(ManagementView, {}), dom.document.body) })

		async function selectTab(label: string) {
			const tab = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === label)
			assert.ok(tab, `Missing ${ label } tab`)
			await act(async () => { await clickRenderedElement(tab) })
		}

		await selectTab('Diagnostics')
		assert.equal(diagnosticsLoads, 1)
		await selectTab('Home')
		await selectTab('Diagnostics')
		assert.equal(diagnosticsLoads, 2)

		await selectTab('Websites')
		assert.equal(websiteLoads > 0, true)
		assert.equal(runtimeListeners.size > 0, true)
		await selectTab('Home')
		assert.equal(dom.document.body.textContent.includes('Manage Websites'), false)
		assert.equal(runtimeListeners.size, 0)
		const loadsAfterLeaving = websiteLoads
		for (const listener of [...runtimeListeners]) listener({ role: 'all', method: 'popup_websiteAccess_changed' })
		assert.equal(websiteLoads, loadsAfterLeaving)
	} finally {
		await act(() => { render(null, dom.document.body) })
		restoreBrowser()
		restoreRemoveEventListener()
		restoreAddEventListener()
		restoreLocation()
		dom.restore()
	}
})
