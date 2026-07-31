import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { type ComponentProps, h, render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { createLazyPage, PopupModal, type PopupPage } from '../../app/ts/components/PopupModal.js'
import { ErrorBoundary } from '../../app/ts/components/subcomponents/Error.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntries } from '../../app/ts/types/rpc.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: { bubbles?: boolean, type: string }) => boolean
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly textContent?: string | null
}

function findByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node?.getAttribute?.('class')?.split(/\s+/).includes(className)) return node
	for (const child of node?.childNodes ?? []) {
		const match = findByClass(child, className)
		if (match !== undefined) return match
	}
	return undefined
}

function findByAttribute(node: TestNode | undefined, name: string, value: string): TestNode | undefined {
	if (node?.getAttribute?.(name) === value) return node
	for (const child of node?.childNodes ?? []) {
		const match = findByAttribute(child, name, value)
		if (match !== undefined) return match
	}
	return undefined
}

function findButtonByText(node: TestNode | undefined, text: string): TestNode | undefined {
	if (node?.tagName === 'BUTTON' && node.textContent?.trim() === text) return node
	for (const child of node?.childNodes ?? []) {
		const match = findButtonByText(child, text)
		if (match !== undefined) return match
	}
	return undefined
}

async function settleLazyPage() {
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForRealLazyPage(isLoaded: () => boolean) {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (isLoaded()) return
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

function createPopupModalProps(page: PopupPage): ComponentProps<typeof PopupModal> {
	return {
		page: signal<PopupPage>(page),
		boundaryResetKey: signal(0),
		onRenderError: () => undefined,
		goHome: () => undefined,
		websiteAccess: signal<WebsiteAccessArray | undefined>(undefined),
		websiteAccessAddressMetadata: signal<AddressBookEntries>([]),
		renameAddressCallBack: () => undefined,
		setActiveAddressAndInformAboutIt: async () => undefined,
		signerAccounts: [],
		activeAddresses: signal<AddressBookEntries>([]),
		signerName: 'NoSignerDetected',
		addNewAddress: () => undefined,
		activeAddress: undefined,
		rpcEntries: signal<RpcEntries>([]),
	}
}

function installBrowserExtensionGlobals() {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: undefined,
				getManifest: () => ({ manifest_version: 3 }),
				sendMessage: async () => undefined,
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return () => {
		if (browserDescriptor === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', browserDescriptor)
		if (chromeDescriptor === undefined) Reflect.deleteProperty(globalThis, 'chrome')
		else Object.defineProperty(globalThis, 'chrome', chromeDescriptor)
	}
}

describe('lazy popup pages', () => {
	test('renders a page after its module loads', async () => {
		const dom = installDomMock()
		const LazyPage = createLazyPage(
			async () => ({ TestPage: ({ label }: { label: string }) => <p>{ label }</p> }),
			'TestPage',
		)
		try {
			await act(() => {
				render(<LazyPage label = 'Loaded popup page' />, dom.document.body)
			})
			await act(settleLazyPage)
			assert.equal(dom.document.body.textContent, 'Loaded popup page')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('reports module load failures through the existing error boundary', async () => {
		const dom = installDomMock()
		const loadError = new Error('Popup page chunk failed to load')
		const LazyPage = createLazyPage<{ label: string }, 'TestPage'>(
			async () => await Promise.reject(loadError),
			'TestPage',
		)
		let caughtError: Error | undefined
		const originalConsoleError = console.error
		console.error = () => undefined
		try {
			await act(() => {
				render(
					<ErrorBoundary onError = { (error) => { caughtError = error } }>
						<LazyPage label = 'unused' />
					</ErrorBoundary>,
					dom.document.body,
				)
			})
			await act(settleLazyPage)
			assert.equal(caughtError, loadError)
		} finally {
			console.error = originalConsoleError
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps Home inactive and renders the selected real modal route', async () => {
		const dom = installDomMock()
		const restoreBrowserGlobals = installBrowserExtensionGlobals()
		try {
			await act(() => {
				render(<PopupModal { ...createPopupModalProps({ page: 'Home' }) } />, dom.document.body)
			})
			assert.equal(findByClass(findByClass(dom.document.body, 'modal'), 'is-active'), undefined)

			await act(() => {
				render(<PopupModal { ...createPopupModalProps({ page: 'ImportSimulation', state: signal('') }) } />, dom.document.body)
			})
			await act(async () => await waitForRealLazyPage(() => dom.document.body.textContent.includes('Import simulation stack')))
			assert.notEqual(findByClass(findByClass(dom.document.body, 'modal'), 'is-active'), undefined)
			assert.match(dom.document.body.textContent, /Import simulation stack/u)
		} finally {
			render(null, dom.document.body)
			restoreBrowserGlobals()
			dom.restore()
		}
	})

	test('renders Website Access with shared dialog semantics and editable access details', async () => {
		const dom = installDomMock()
		const restoreBrowserGlobals = installBrowserExtensionGlobals()
		let closeCount = 0
		const accountAddress = 0x1111111111111111111111111111111111111111n
		const props = createPopupModalProps({ page: 'AccessList' })
		props.goHome = () => { closeCount += 1 }
		props.websiteAccess = signal<WebsiteAccessArray | undefined>([{
			website: { websiteOrigin: 'https://example.test', icon: undefined, title: 'Example' },
			addressAccess: [{ address: accountAddress, access: true }],
			access: true,
			interceptorDisabled: false,
			declarativeNetRequestBlockMode: 'disabled',
		}])
		props.websiteAccessAddressMetadata = signal<AddressBookEntries>([{
			type: 'contact',
			name: 'Test account',
			address: accountAddress,
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: true,
		}])
		try {
			await act(() => {
				render(<PopupModal { ...props } />, dom.document.body)
			})
			await act(async () => await waitForRealLazyPage(() => dom.document.body.textContent.includes('https://example.test')))

			const dialog = findByAttribute(dom.document.body, 'aria-label', 'Website access')
			assert.notEqual(dialog, undefined)
			assert.equal(dialog?.getAttribute?.('role'), 'dialog')
			assert.match(dialog?.textContent ?? '', /https:\/\/example\.test/u)
			assert.match(dialog?.textContent ?? '', /Test account/u)
			assert.notEqual(findButtonByText(dialog, 'Cancel'), undefined)
			assert.notEqual(findButtonByText(dialog, 'Close'), undefined)

			findButtonByText(dialog, 'Cancel')?.dispatchEvent?.({ type: 'click', bubbles: true })
			assert.equal(closeCount, 1)
		} finally {
			render(null, dom.document.body)
			restoreBrowserGlobals()
			dom.restore()
		}
	})
})
