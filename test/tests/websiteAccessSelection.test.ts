import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { Signal } from '@preact/signals'
import { act } from 'preact/test-utils'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'
import { type BrowserMock, installBrowserMock } from '../harness/browserMock.js'
import { replaceGlobal, replaceProperty } from '../harness/globals.js'
import { installDomMock, isMockDialogElement, isMockElement, type MockElement, type MockNode } from './domMock.js'
import { clickElement, collectElements, getElement, getPreactEventHandler } from './domQueries.js'
import { readProperty } from '../harness/assertions.js'

// The page's runtime message listeners, so a test can count the listeners its view added and removed.
function trackRuntimeMessageListeners(browserMock: BrowserMock) {
	const listeners: unknown[] = []
	const onMessage = browserMock.browser.runtime.onMessage
	const addListener = onMessage.addListener
	const removeListener = onMessage.removeListener
	onMessage.addListener = (listener) => {
		if (!onMessage.hasListener(listener)) listeners.push(listener)
		addListener(listener)
	}
	onMessage.removeListener = (listener) => {
		const index = listeners.indexOf(listener)
		if (index >= 0) listeners.splice(index, 1)
		removeListener(listener)
	}
	return () => [...listeners]
}

function installWindowHashMock(initialHash: string) {
	const dom = installDomMock()
	const hashChangeListeners = new Set<EventListenerOrEventListenerObject>()
	let currentHash = initialHash

	const dispatchHashChange = () => {
		const event = new Event('hashchange')
		for (const listener of hashChangeListeners) {
			if (typeof listener === 'function') listener(event)
			else listener.handleEvent(event)
		}
	}

	const location = {
		pathname: '/websiteAccess.html',
		get href() {
			return `${ this.pathname }${ currentHash }`
		},
		set href(value: string) {
			const hashIndex = value.indexOf('#')
			currentHash = hashIndex === -1 ? '' : value.slice(hashIndex)
			dispatchHashChange()
		},
		get hash() {
			return currentHash
		},
		set hash(nextHash: string) {
			currentHash = nextHash.length === 0 || nextHash.startsWith('#') ? nextHash : `#${ nextHash }`
			dispatchHashChange()
		},
	}

	const restoreWindowProperties = [
		replaceProperty(globalThis.window, 'addEventListener', (type: string, listener: EventListenerOrEventListenerObject) => {
			if (type === 'hashchange') hashChangeListeners.add(listener)
		}),
		replaceProperty(globalThis.window, 'removeEventListener', (type: string, listener: EventListenerOrEventListenerObject) => {
			if (type === 'hashchange') hashChangeListeners.delete(listener)
		}),
		replaceProperty(globalThis.window, 'location', location),
	]

	return {
		document: dom.document,
		restore() {
			for (const restoreWindowProperty of restoreWindowProperties.reverse()) restoreWindowProperty()
			dom.restore()
		},
		setHash(nextHash: string) {
			location.hash = nextHash
		},
	}
}

const findRadioByValue = (root: MockNode, value: string) => collectElements(root, 'input').find((element) => element.getAttribute('type') === 'radio' && element.getAttribute('value') === value)

const isChecked = (element: MockElement) => element.hasAttribute('checked')

const RealFormData = globalThis.FormData

// The DOM mock has no form controls for FormData to read, so typing calls the search form's input handler while FormData returns the typed text for the search box, the form's only named field.
async function typeSearchQuery(searchForm: MockElement, query: string) {
	const restoreFormData = replaceGlobal('FormData', function FormDataWithTypedSearch() {
		const formData = new RealFormData()
		formData.set('search', query)
		return formData
	})
	try {
		// Lowercase on purpose: WebsiteAccess.tsx imports preact/compat, whose vnode hook renames every onInput prop to oninput (preact/compat/src/render.js), so this form's handler is stored under 'input' rather than the 'Input' key that plain Preact uses on DOM-mock elements. 'Input' would throw here.
		await getPreactEventHandler(searchForm, 'input')({ currentTarget: searchForm })
	} finally {
		restoreFormData()
	}
}

const websiteAccessEntries: readonly WebsiteAccess[] = [
	{
		website: { websiteOrigin: 'alpha.example', icon: 'alpha.png', title: 'Alpha' },
		addressAccess: undefined,
		access: true,
	},
	{
		website: { websiteOrigin: 'beta.example', icon: 'beta.png', title: 'Beta' },
		addressAccess: undefined,
		access: true,
	},
]

const revokedWebsiteAccessEntry: WebsiteAccess = {
	website: { websiteOrigin: 'revoked.example', icon: 'revoked.png', title: 'Revoked' },
	addressAccess: undefined,
}

const deniedWebsiteAccessEntry: WebsiteAccess = {
	website: { websiteOrigin: 'denied.example', icon: 'denied.png', title: 'Denied' },
	addressAccess: undefined,
	access: false,
}

const serializedAddressAccessEntry = {
	website: { websiteOrigin: 'app.sablier.com', icon: 'sablier.png', title: 'Sablier' },
	addressAccess: [{ address: '0x1111111111111111111111111111111111111111', access: true }],
	access: true,
}

const serializedAddressAccessMetadata = [{
	type: 'contact',
	name: 'Primary',
	address: '0x1111111111111111111111111111111111111111',
	entrySource: 'User',
	askForAddressAccess: true,
	useAsActiveAddress: true,
	chainId: '0x1',
}]

// One mock for the whole file, because views rendered by earlier tests stay mounted and keep their runtime listeners.
const browserMock = installBrowserMock()
const getRuntimeMessageListeners = trackRuntimeMessageListeners(browserMock)
const modulesPromise = import('../../app/ts/components/pages/WebsiteAccess.js')

describe('WebsiteAccessView selection', () => {
	test('binds the checked radio to the selected domain from the URL hash', async () => {
		const dom = installWindowHashMock('#origin:beta.example')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(async () => {
			await browserMock.dispatchRuntimeMessage({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: websiteAccessEntries,
					addressAccessMetadata: [],
				},
			})
		})

		const alphaRadio = findRadioByValue(dom.document.body, 'alpha.example')
		const betaRadio = findRadioByValue(dom.document.body, 'beta.example')
		if (alphaRadio === undefined || betaRadio === undefined) throw new Error('Expected a radio button for each website')
		assert.equal(isChecked(alphaRadio), false)
		assert.equal(isChecked(betaRadio), true)

		await act(() => {
			dom.setHash('#origin:alpha.example')
		})

		assert.equal(isChecked(alphaRadio), true)
		assert.equal(isChecked(betaRadio), false)
		dom.restore()
	})

	test('shows the denied prompt only for explicitly denied websites', async () => {
		const dom = installWindowHashMock('#origin:revoked.example')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(async () => {
			await browserMock.dispatchRuntimeMessage({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: [revokedWebsiteAccessEntry],
					addressAccessMetadata: [],
				},
			})
		})

		assert.equal(dom.document.body.textContent.includes('This website was denied access to The Interceptor.'), false)

		await act(async () => {
			dom.setHash('#origin:denied.example')
			await browserMock.dispatchRuntimeMessage({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: [deniedWebsiteAccessEntry],
					addressAccessMetadata: [],
				},
			})
		})

		assert.equal(dom.document.body.textContent.includes('This website was denied access to The Interceptor.'), true)
		dom.restore()
	})

	test('auto-selects the only matching website so its approved address is visible', async () => {
		const dom = installWindowHashMock('')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(async () => {
			await browserMock.dispatchRuntimeMessage({
				role: 'all',
					method: 'popup_retrieveWebsiteAccessReply',
					data: {
						websiteAccess: [serializedAddressAccessEntry],
						addressAccessMetadata: serializedAddressAccessMetadata,
					},
				})
		})

		assert.equal(dom.document.body.textContent.includes('app.sablier.com'), true)
		assert.equal(dom.document.body.textContent.includes('Primary'), true)

		const removeAddressDialog = collectElements(dom.document.body, 'dialog').filter((dialog) => dialog.textContent.includes('Removing Address')).at(-1)
		if (!isMockDialogElement(removeAddressDialog)) throw new Error('Expected remove address dialog')
		const dialogSiblings = removeAddressDialog.parentNode?.childNodes ?? []
		const removeAddressButton = dialogSiblings[dialogSiblings.indexOf(removeAddressDialog) - 1]
		if (!isMockElement(removeAddressButton)) throw new Error('Expected remove address button')

		await act(async () => {
			await clickElement(removeAddressButton)
		})
		assert.equal(removeAddressDialog.open, true)

		const editAddressButton = collectElements(removeAddressDialog, 'button').find((button) => button.textContent.trim() === 'edit')
		if (editAddressButton === undefined) throw new Error('Expected address edit button in remove dialog')

		await act(async () => {
			await clickElement(editAddressButton)
		})

		assert.equal(removeAddressDialog.open, false)
		assert.equal(dom.document.body.textContent.includes('Contract ABI'), true)
		dom.restore()
	})

	test('keeps a constant number of runtime listeners across re-renders and removes them on unmount', async () => {
		const dom = installWindowHashMock('#origin:beta.example')
		const { WebsiteAccessView } = await modulesPromise
		// Views from earlier tests stay mounted, so only count listeners this view added.
		const listenersBeforeRender = new Set(getRuntimeMessageListeners())
		const getListenersAddedByThisView = () => getRuntimeMessageListeners().filter((listener) => !listenersBeforeRender.has(listener))
		const dispatchWebsiteAccessReply = async () => await act(async () => {
			await browserMock.dispatchRuntimeMessage({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: { websiteAccess: websiteAccessEntries, addressAccessMetadata: [] },
			})
		})
		try {
			await act(() => {
				render(h(WebsiteAccessView, {}), dom.document.body)
			})
			await dispatchWebsiteAccessReply()
			const listenerCountAfterFirstRender = getListenersAddedByThisView().length
			await dispatchWebsiteAccessReply()
			await dispatchWebsiteAccessReply()
			assert.equal(dom.document.body.textContent.includes('Show website access list'), true, 'the selected website details are rendered')
			assert.equal(getListenersAddedByThisView().length, listenerCountAfterFirstRender)

			await act(() => {
				render(null, dom.document.body)
			})
			assert.deepEqual(getListenersAddedByThisView(), [])
		} finally {
			dom.restore()
		}
	})

	test('refreshes the website list with the search text instead of the selected website after an access change', async () => {
		const dom = installWindowHashMock('#origin:beta.example')
		const { WebsiteAccessView } = await modulesPromise
		try {
			await act(() => {
				render(h(WebsiteAccessView, {}), dom.document.body)
			})
			await act(async () => {
				await browserMock.dispatchRuntimeMessage({
					role: 'all',
					method: 'popup_retrieveWebsiteAccessReply',
					data: { websiteAccess: websiteAccessEntries, addressAccessMetadata: [] },
				})
			})
			const searchForm = getElement(dom.document.body, (element) => element.tagName === 'FORM' && element.getAttribute('role') === 'search', 'the website search form')
			await act(async () => { await typeSearchQuery(searchForm, 'bet') })
			// Typing clears the selection, so select a website again to have both a search text and a different selected domain.
			await act(() => { dom.setHash('#origin:beta.example') })
			const betaRadio = findRadioByValue(dom.document.body, 'beta.example')
			assert.equal(betaRadio !== undefined && isChecked(betaRadio), true)

			const sentMessages = browserMock.calls.runtimeSendMessage
			const sentMessageCountBeforeChange = sentMessages.length
			await act(async () => {
				await browserMock.dispatchRuntimeMessage({ role: 'all', method: 'popup_websiteAccess_changed' })
			})
			// Views from earlier tests stay mounted and refresh too with their empty search box; this view is the only one with search text.
			const refreshQueries = sentMessages.slice(sentMessageCountBeforeChange)
				.filter((message) => readProperty(message, 'method') === 'popup_retrieveWebsiteAccess')
				.map((message) => readProperty(readProperty(message, 'data'), 'query'))
			assert.deepEqual(refreshQueries.filter((query) => query !== ''), ['bet'])
			await act(() => {
				render(null, dom.document.body)
			})
		} finally {
			dom.restore()
		}
	})

	test('clears the selected website even when the URL hash is already empty', async () => {
		const dom = installWindowHashMock('')
		try {
			const { clearSelectedWebsite } = await modulesPromise
			const selectedDomain = new Signal<string | undefined>('app.sablier.com')

			clearSelectedWebsite(globalThis.window, selectedDomain)

			assert.equal(selectedDomain.value, undefined)
			assert.equal(globalThis.window.location.hash, '')
		} finally {
			dom.restore()
		}
	})
})
