import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { type ComponentProps, render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { createLazyPage, PopupModal, type PopupPage } from '../../app/ts/components/PopupModal.js'
import { ErrorBoundary } from '../../app/ts/components/subcomponents/Error.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntries } from '../../app/ts/types/rpc.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { installDomMock, type MockElement } from './domMock.js'
import { findElementByClass, waitForRender } from './domQueries.js'
import { replaceProperty } from '../harness/globals.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const findActiveModal = (root: MockElement) => {
	const modal = findElementByClass(root, 'modal')
	return modal === undefined ? undefined : findElementByClass(modal, 'is-active')
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
		allowCreateAndSwitch: true,
		signerAccounts: [],
		activeAddresses: signal<AddressBookEntries>([]),
		signerName: 'NoSignerDetected',
		addNewAddress: () => undefined,
		activeAddress: undefined,
		rpcEntries: signal<RpcEntries>([]),
	}
}

const installBrowserMock = createPerTestBrowserMockInstaller()

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
			await waitForRender(() => dom.document.body.textContent === 'Loaded popup page', { description: 'the lazy page to render' })
			assert.equal(dom.document.body.textContent, 'Loaded popup page')
		} finally {
			render(undefined, dom.document.body)
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
		const errorBoundary: { caughtError?: Error } = {}
		const restoreConsoleError = replaceProperty(console, 'error', () => undefined)
		try {
			await act(() => {
				render(
					<ErrorBoundary onError = { (error) => { errorBoundary.caughtError = error } }>
						<LazyPage label = 'unused' />
					</ErrorBoundary>,
					dom.document.body,
				)
			})
			await waitForRender(() => errorBoundary.caughtError !== undefined, { description: 'the error boundary to catch the load failure' })
			assert.equal(errorBoundary.caughtError, loadError)
		} finally {
			restoreConsoleError()
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('keeps Home inactive and renders the selected real modal route', async () => {
		const dom = installDomMock()
		installBrowserMock()
		try {
			await act(() => {
				render(<PopupModal { ...createPopupModalProps({ page: 'Home' }) } />, dom.document.body)
			})
			assert.equal(findActiveModal(dom.document.body), undefined)

			await act(() => {
				render(<PopupModal { ...createPopupModalProps({ page: 'ImportSimulation', state: signal('') }) } />, dom.document.body)
			})
			await waitForRender(() => dom.document.body.textContent.includes('Import Interceptor Simulation Stack'), { description: 'the import page to load' })
			assert.notEqual(findActiveModal(dom.document.body), undefined)
			assert.match(dom.document.body.textContent, /Import Interceptor Simulation Stack/u)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('hides create-and-switch actions when signing mode restricts address selection', async () => {
		const dom = installDomMock()
		installBrowserMock()
		const state = signal({
			windowStateId: 'signing-address-create',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				type: 'contact' as const,
				address: '0x1000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Saved EOA',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: true,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})
		try {
			await act(() => {
				render(<PopupModal { ...createPopupModalProps({ page: 'AddNewAddress', state }) } allowCreateAndSwitch = { false } />, dom.document.body)
			})
			await waitForRender(() => dom.document.body.textContent.includes('Create address'), { description: 'the address page to load' })
			assert.equal(dom.document.body.textContent.includes('Create and switch'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
