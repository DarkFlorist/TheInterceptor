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
	readonly getAttribute?: (name: string) => string | null
}

function findByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node?.getAttribute?.('class')?.split(/\s+/).includes(className)) return node
	for (const child of node?.childNodes ?? []) {
		const match = findByClass(child, className)
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
			await act(async () => await waitForRealLazyPage(() => dom.document.body.textContent.includes('Import Interceptor Simulation Stack')))
			assert.notEqual(findByClass(findByClass(dom.document.body, 'modal'), 'is-active'), undefined)
			assert.match(dom.document.body.textContent, /Import Interceptor Simulation Stack/u)
		} finally {
			render(null, dom.document.body)
			restoreBrowserGlobals()
			dom.restore()
		}
	})
})
