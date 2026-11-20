import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { Signal } from '@preact/signals'
import { act } from 'preact/test-utils'
import { installDomMock } from './domMock.js'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'

type RuntimeMessageListener = (message: unknown) => unknown
type RuntimeMessage = {
	method?: string
	data?: unknown
}

type DomElement = {
	tagName?: string
	childNodes?: readonly DomElement[]
	parentNode?: DomElement | null
	textContent?: string | null
	type?: string
	value?: string
	checked?: boolean
	attributes?: Record<string, string | undefined>
	l?: Record<string, (event: unknown) => unknown>
	open?: boolean
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
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
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
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}

	Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })

	return {
		dispatch(message: RuntimeMessage) {
			for (const listener of [...listeners]) listener(message)
		},
		sentMessages,
	}
}

// The shell owns the route, so the view is driven by its websiteOrigin prop and reports selections through selectWebsite.
function renderWebsiteAccessView(WebsiteAccessView: (props: { websiteOrigin: string | undefined, selectWebsite: (websiteOrigin: string | undefined) => void }) => unknown, initialOrigin: string | undefined) {
	const dom = installDomMock()
	const selections: (string | undefined)[] = []
	const selectWebsite = (websiteOrigin: string | undefined) => { selections.push(websiteOrigin) }
	const renderWithOrigin = (websiteOrigin: string | undefined) => { render(h(WebsiteAccessView, { websiteOrigin, selectWebsite }), dom.document.body) }
	renderWithOrigin(initialOrigin)
	return {
		document: dom.document,
		selections,
		setRouteOrigin: renderWithOrigin,
		restore() {
			render(null, dom.document.body)
			dom.restore()
		},
	}
}

function collectElements(node: DomElement, tagName: string, results: DomElement[] = []) {
	if (node.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function findRadioByValue(root: DomElement, value: string) {
	return collectElements(root, 'input').find((element) =>
		(element.type === 'radio' || element.attributes?.type === 'radio')
		&& (element.value === value || element.attributes?.value === value || element.attributes?.id === value)
	)
}

function isChecked(element: DomElement) {
	return element.checked === true || element.attributes?.checked !== undefined
}

async function changeElement(element: DomElement) {
	const changeHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Change'))?.[1]
	if (changeHandler === undefined) throw new Error('Expected change handler')
	await changeHandler({ currentTarget: element })
}

async function clickElement(element: DomElement) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element, stopPropagation() { return undefined } })
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
	type: 'contact' as const,
	name: 'Primary',
	address: '0x1111111111111111111111111111111111111111',
	entrySource: 'User' as const,
	askForAddressAccess: true,
	useAsActiveAddress: true,
	chainId: '0x1',
}]

const browserMock = createBrowserMock()
const modulesPromise = import('../../app/ts/components/pages/WebsiteAccess.js')

describe('WebsiteAccessView selection', () => {
	test('binds the checked radio to the website origin from the route and reports selections to the shell', async () => {
		const { WebsiteAccessView } = await modulesPromise
		let dom: ReturnType<typeof renderWebsiteAccessView> | undefined
		await act(() => {
			dom = renderWebsiteAccessView(WebsiteAccessView, 'beta.example')
		})
		if (dom === undefined) throw new Error('Expected rendered website view')

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

		const alphaRadio = findRadioByValue(dom.document.body, 'alpha.example')
		const betaRadio = findRadioByValue(dom.document.body, 'beta.example')

		assert.ok(alphaRadio)
		assert.ok(betaRadio)
		assert.equal(isChecked(alphaRadio), false)
		assert.equal(isChecked(betaRadio), true)

		await act(() => {
			dom?.setRouteOrigin('alpha.example')
		})

		assert.equal(isChecked(alphaRadio), true)
		assert.equal(isChecked(betaRadio), false)

		await act(async () => {
			await changeElement(betaRadio)
		})
		assert.deepEqual(dom.selections, ['beta.example'])
		dom.restore()
	})

	test('shows the denied prompt only for explicitly denied websites', async () => {
		const { WebsiteAccessView } = await modulesPromise
		let dom: ReturnType<typeof renderWebsiteAccessView> | undefined
		await act(() => {
			dom = renderWebsiteAccessView(WebsiteAccessView, 'revoked.example')
		})
		if (dom === undefined) throw new Error('Expected rendered website view')

		await act(() => {
			browserMock.dispatch({
				role: 'all',
				method: 'popup_retrieveWebsiteAccessReply',
				data: {
					websiteAccess: [revokedWebsiteAccessEntry],
					addressAccessMetadata: [],
				},
			})
		})

		assert.equal(dom.document.body.textContent.includes('This website was denied access to The Interceptor.'), false)

		await act(() => {
			dom?.setRouteOrigin('denied.example')
			browserMock.dispatch({
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
		const { WebsiteAccessView } = await modulesPromise
		let dom: ReturnType<typeof renderWebsiteAccessView> | undefined
		await act(() => {
			dom = renderWebsiteAccessView(WebsiteAccessView, undefined)
		})
		if (dom === undefined) throw new Error('Expected rendered website view')

		await act(() => {
			browserMock.dispatch({
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

		const removeAddressDialog = collectElements(dom.document.body, 'dialog').filter((dialog) => dialog.textContent?.includes('Removing Address')).at(-1)
		if (removeAddressDialog === undefined) throw new Error('Expected remove address dialog')
		const dialogSiblings = removeAddressDialog.parentNode?.childNodes ?? []
		const removeAddressButton = dialogSiblings[dialogSiblings.indexOf(removeAddressDialog) - 1]
		if (removeAddressButton === undefined) throw new Error('Expected remove address button')

		await act(async () => {
			await clickElement(removeAddressButton)
		})
		assert.equal(removeAddressDialog.open, true)

		const editAddressButton = collectElements(removeAddressDialog, 'button').find((button) => button.textContent?.trim() === 'edit')
		if (editAddressButton === undefined) throw new Error('Expected address edit button in remove dialog')

		await act(async () => {
			await clickElement(editAddressButton)
		})

		assert.equal(removeAddressDialog.open, false)
		assert.equal(dom.document.body.textContent.includes('Contract ABI'), true)
		dom.restore()
	})

	test('asks the shell to return to the website list when the selected website is cleared', async () => {
		const { clearSelectedWebsite } = await modulesPromise
		const selectedDomain = new Signal<string | undefined>('app.sablier.com')
		const selections: (string | undefined)[] = []

		clearSelectedWebsite((websiteOrigin) => { selections.push(websiteOrigin) }, selectedDomain)

		assert.equal(selectedDomain.value, undefined)
		assert.deepEqual(selections, [undefined])
	})
})
