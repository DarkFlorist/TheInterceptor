import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { installDomMock, type RenderContainer } from './domMock.js'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'

type RuntimeMessageListener = (message: unknown) => unknown
type RuntimeMessage = {
	method?: string
	data?: unknown
}

type DomElement = {
	tagName?: string
	childNodes?: readonly DomElement[]
	type?: string
	value?: string
	checked?: boolean
	attributes?: Record<string, string | undefined>
}

function createBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const sentMessages: RuntimeMessage[] = []
	const storageState: Record<string, unknown> = {}

	const browserMock = {
		runtime: {
			lastError: null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener(listener: RuntimeMessageListener) {
					listeners.push(listener)
				},
				removeListener(listener: RuntimeMessageListener) {
					const index = listeners.indexOf(listener)
					if (index >= 0) listeners.splice(index, 1)
				},
			},
			onConnect: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() {
				return []
			},
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
			onUpdated: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
			onRemoved: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
		windows: {
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
		},
		action: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		browserAction: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
	}

	Object.defineProperty(globalThis, 'browser', {
		value: browserMock,
		configurable: true,
		writable: true,
	})
	Object.defineProperty(globalThis, 'chrome', {
		value: { runtime: { id: 'test-extension' } },
		configurable: true,
		writable: true,
	})

	return {
		dispatch(message: RuntimeMessage) {
			for (const listener of [...listeners]) listener(message)
		},
		sentMessages,
	}
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

	globalThis.window.addEventListener = (type, listener) => {
		if (type === 'hashchange') hashChangeListeners.add(listener)
	}
	globalThis.window.removeEventListener = (type, listener) => {
		if (type === 'hashchange') hashChangeListeners.delete(listener)
	}
	Object.defineProperty(globalThis.window, 'location', {
		value: location,
		configurable: true,
		writable: true,
	})

	return {
		document: dom.document,
		restore() {
			dom.restore()
		},
		setHash(nextHash: string) {
			location.hash = nextHash
		},
	}
}

function collectElements(node: DomElement, tagName: string, results: DomElement[] = []) {
	if (node.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function findRadioByValue(root: DomElement, value: string) {
	return collectElements(root, 'input').find((element) => (element.type === 'radio' || element.attributes?.type === 'radio') && (element.value === value || element.attributes?.value === value || element.attributes?.id === value))
}

function isChecked(element: DomElement) {
	return element.checked === true || element.attributes?.checked !== undefined
}

async function unmountView(root: RenderContainer) {
	await act(() => {
		render(null, root)
	})
}

const websiteAccessEntries: readonly WebsiteAccess[] = [
	{
		website: {
			websiteOrigin: 'alpha.example',
			icon: 'alpha.png',
			title: 'Alpha',
		},
		addressAccess: undefined,
		access: true,
	},
	{
		website: { websiteOrigin: 'beta.example', icon: 'beta.png', title: 'Beta' },
		addressAccess: undefined,
		access: true,
	},
]

const browserMock = createBrowserMock()
const modulesPromise = import('../../app/ts/components/pages/WebsiteAccess.js')

describe('WebsiteAccessView selection', () => {
	test('binds the checked radio to the selected domain from the URL hash', async () => {
		const dom = installWindowHashMock('#origin:beta.example')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(() => {
			browserMock.dispatch({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: websiteAccessEntries,
					addressAccessMetadata: [],
				},
			})
		})
		await act(async () => {
			await Promise.resolve()
		})

		const alphaRadio = findRadioByValue(dom.document.body, 'alpha.example')
		const betaRadio = findRadioByValue(dom.document.body, 'beta.example')

		assert.ok(alphaRadio)
		assert.ok(betaRadio)
		assert.equal(isChecked(alphaRadio), false)
		assert.equal(isChecked(betaRadio), true)

		await act(() => {
			dom.setHash('#origin:alpha.example')
		})

		assert.equal(isChecked(alphaRadio), true)
		assert.equal(isChecked(betaRadio), false)
		await unmountView(dom.document.body)
		dom.restore()
	})

	test('describes hostname-scoped actions when sibling origins share a host', async () => {
		const dom = installWindowHashMock('#origin:localhost:3000')
		const { WebsiteAccessView } = await modulesPromise
		const localhostEntries: readonly WebsiteAccess[] = [
			{
				website: {
					websiteOrigin: 'localhost:3000',
					icon: 'alpha.png',
					title: 'Local App A',
				},
				addressAccess: undefined,
				access: true,
			},
			{
				website: {
					websiteOrigin: 'localhost:5173',
					icon: 'beta.png',
					title: 'Local App B',
				},
				addressAccess: undefined,
				access: true,
			},
		]

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(() => {
			browserMock.dispatch({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: localhostEntries,
					addressAccessMetadata: [],
				},
			})
		})
		await act(async () => {
			await Promise.resolve()
		})

		assert.ok(dom.document.body.textContent.includes('These settings apply to all sites on localhost.'))
		assert.ok(dom.document.body.textContent.includes('Affected sites: localhost:3000, localhost:5173'))
		assert.ok(dom.document.body.textContent.includes('This includes sibling origin on other port or scheme variants.'))
		assert.ok(dom.document.body.textContent.includes('Remove Host Access'))
		await unmountView(dom.document.body)
		dom.restore()
	})

	test('single-origin hosts do not claim sibling origins exist', async () => {
		const dom = installWindowHashMock('#origin:solo.example')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(() => {
			browserMock.dispatch({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: [
						{
							website: {
								websiteOrigin: 'solo.example',
								icon: 'solo.png',
								title: 'Solo',
							},
							addressAccess: undefined,
							access: true,
						},
					],
					addressAccessMetadata: [],
				},
			})
		})
		await act(async () => {
			await Promise.resolve()
		})

		assert.ok(dom.document.body.textContent.includes('Affected site: solo.example'))
		assert.equal(dom.document.body.textContent.includes('This includes sibling origin'), false)
		await unmountView(dom.document.body)
		dom.restore()
	})

	test('selection lookup stays stable when the sidebar would be filtered', async () => {
		const { deriveWebsiteAccessViewState } = await modulesPromise
		const allWebsiteAccess: readonly WebsiteAccess[] = [
			{
				website: {
					websiteOrigin: 'localhost:3000',
					icon: 'alpha.png',
					title: 'Local App A',
				},
				addressAccess: undefined,
				access: true,
			},
			{
				website: {
					websiteOrigin: 'localhost:5173',
					icon: 'beta.png',
					title: 'Local App B',
				},
				addressAccess: undefined,
				access: true,
			},
		]
		const viewState = deriveWebsiteAccessViewState(allWebsiteAccess, '3000', 'localhost:5173')

		assert.deepEqual(
			viewState.websiteAccessList.map((entry) => entry.website.websiteOrigin),
			['localhost:3000'],
		)
		assert.equal(viewState.selectedWebsiteAccess?.website.websiteOrigin, 'localhost:5173')
		assert.deepEqual(viewState.hostScopeDetails?.affectedOrigins, ['localhost:3000', 'localhost:5173'])
	})

	test('loaded empty website access clears stale hash-backed selection', async () => {
		const dom = installWindowHashMock('#origin:solo.example')
		const { WebsiteAccessView } = await modulesPromise

		await act(() => {
			render(h(WebsiteAccessView, {}), dom.document.body)
		})

		await act(() => {
			browserMock.dispatch({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: [],
					addressAccessMetadata: [],
				},
			})
		})
		await act(async () => {
			await Promise.resolve()
		})

		assert.equal(globalThis.window.location.hash, '')
		await unmountView(dom.document.body)
		dom.restore()
	})
})
