import type { RpcEntries, RpcEntry } from '../../app/ts/types/rpc.js'
import { getRpcEntryIdentityKey } from '../../app/ts/utils/rpcNetworkChange.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { requestPopupSettingsChange } from '../../app/ts/components/popupSettingsChange.js'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { findChainEntryByName, findRpcEntryByIdentityKey, getRpcEntryLabel } from '../../app/ts/components/subcomponents/ChainSelector.js'
import { DropDownMenu } from '../../app/ts/components/subcomponents/DropDownMenu.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { hasValidTimePickerValue, parseTimePickerDeltaValue, TimePicker } from '../../app/ts/components/subcomponents/TimePicker.js'
import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../../app/ts/components/ui-utils.js'
import { getRpcFormMode, parseRpcFormData } from '../../app/ts/utils/rpcFormData.js'
import { removeAddressBookEntryAndClose } from '../../app/ts/AddressBook.js'
import { completeRpcFormMutation, ConfigureRpcForm, removeRpcEntryAndKeepActiveRpcConsistent, RpcQueryProvider, saveRpcEntryAndKeepActiveRpcConsistent } from '../../app/ts/components/subcomponents/ConfigureRpcConnection.js'
import { readAndImportSettingsFile, withObjectUrl } from '../../app/ts/components/pages/SettingsView.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { installDomMock } from './domMock.js'
import { synchronizeViewConfig, ViewSelector } from '../../app/ts/components/subcomponents/ViewSelector.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly l?: Record<string, (event: unknown) => unknown>
	value?: string
	setCustomValidity?: (message: string) => void
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

const NativeFormData = globalThis.FormData

// Stands in for the FormData global while the RPC form is rendered: Bun's FormData ignores form elements, and the DOM mock keeps Preact's defaultValue prop as an attribute, so this collects the named inputs like a browser would. The form calls it with `new`, which returns the native FormData built here.
function formDataFromRenderedInputs(form?: TestNode) {
	const formData = new NativeFormData()
	for (const input of collectElements(form, 'input')) {
		const name = input.getAttribute?.('name')
		if (name === null || name === undefined) continue
		formData.set(name, input.value ?? input.getAttribute?.('defaultValue') ?? '')
	}
	return formData
}

// A native submit event carrying the form as its target and the clicked button as its submitter; the SubmitEvent global is the native Event while the form is rendered, so the form's instanceof check accepts it.
function createSubmitEvent(form: TestNode, submitter: TestNode) {
	const event = new Event('submit', { cancelable: true })
	Object.defineProperty(event, 'target', { configurable: true, value: form })
	Object.defineProperty(event, 'submitter', { configurable: true, value: submitter })
	return event
}

async function withGlobalValues(values: Record<string, unknown>, run: () => Promise<void>) {
	const previousDescriptors = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
	for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
	try {
		await run()
	} finally {
		for (const [name, descriptor] of previousDescriptors) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
			else Object.defineProperty(globalThis, name, descriptor)
		}
	}
}

function findInput(inputs: readonly TestNode[], attributeName: string, attributeValue: string) {
	const input = inputs.find((candidate) => candidate.getAttribute?.(attributeName) === attributeValue)
	if (input === undefined) throw new Error(`Expected an input with ${ attributeName } ${ attributeValue }`)
	return input
}

// Calls the input listener Preact registered, as typing would; the RPC URL field debounces this into an RPC probe. TextInput renders through preact/compat, which registers onInput under its lowercase name.
async function typeIntoInput(input: TestNode, value: string) {
	input.value = value
	const inputHandler = input.l?.['inputfalse']
	if (inputHandler === undefined) throw new Error('Expected an input listener')
	await act(async () => { inputHandler({ currentTarget: input }) })
}

async function waitForRenderedState(condition: () => boolean, timeoutMs = 3000) {
	const startedAt = Date.now()
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for the rendered state')
		await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))
	}
}

// Renders the RPC form, lets the test inspect and fill its inputs, then submits it through the rendered Save button. Network requests are counted instead of sent.
async function renderAndSaveRpcForm(defaultValues: RpcEntry | undefined, prepareInputs: (inputs: readonly TestNode[]) => void | Promise<void>) {
	const dom = installDomMock()
	const savedEntries: RpcEntry[] = []
	let formClosed = false
	let fetchCalls = 0
	let renderedText = ''
	const countingFetch = async () => {
		fetchCalls += 1
		throw new Error('The RPC form test does not serve network requests')
	}
	try {
		await withGlobalValues({ SubmitEvent: Event, HTMLFormElement: globalThis.Element, HTMLButtonElement: globalThis.Element, FormData: formDataFromRenderedInputs, fetch: countingFetch }, async () => {
			await act(() => render(<RpcQueryProvider><ConfigureRpcForm defaultValues = { defaultValues } onCancel = { () => { formClosed = true } } onSave = { async (entry) => { savedEntries.push(entry) } } /></RpcQueryProvider>, dom.document.body))
			await prepareInputs(collectElements(dom.document.body, 'input'))

			const form = collectElements(dom.document.body, 'form')[0]
			const saveButton = collectElements(form, 'button').find((button) => button.getAttribute?.('value') === 'save')
			const submitHandler = form?.l?.['Submitfalse']
			if (form === undefined || saveButton === undefined || submitHandler === undefined) throw new Error('Expected the rendered RPC form')
			// The DOM mock keeps Preact's value prop as an attribute; expose it as the button property the submit handler reads.
			saveButton.value = saveButton.getAttribute?.('value') ?? undefined

			await act(async () => { submitHandler(createSubmitEvent(form, saveButton)) })
			for (let attempt = 0; attempt < 20 && !formClosed; attempt += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
			renderedText = dom.document.body.textContent
		})
		return { savedEntries, formClosed, fetchCalls, renderedText }
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
}

function createRpcFormData(apiKey: string) {
	const formData = new FormData()
	formData.set('name', 'Test RPC')
	formData.set('chainId', '1')
	formData.set('httpsRpc', 'https://rpc.example')
	formData.set('currencyName', 'Ether')
	formData.set('currencyTicker', 'ETH')
	formData.set('blockExplorerUrl', 'https://explorer.example/api')
	formData.set('blockExplorerApiKey', apiKey)
	return formData
}

describe('UI boundary fixes', () => {
	test('selects normalized and synthetic chain entries by their displayed names', () => {
		const chains = rpcEntriesToChainEntriesWithAllChainsEntry([{
			name: 'Custom Ethereum Name',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: false,
			minimized: true,
		}])

		assert.equal(findChainEntryByName(chains, 'Ethereum Mainnet')?.chainId, 1n)
		assert.equal(findChainEntryByName(chains, 'All Chains')?.chainId, 'AllChains')
	})

	test('selects duplicate-named RPC entries by URL', () => {
		const entries = [
			{ name: 'Same name', chainId: 1n, httpsRpc: 'https://first.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true },
			{ name: 'Same name', chainId: 1n, httpsRpc: 'https://second.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: true },
		] as const

		assert.equal(findRpcEntryByIdentityKey(entries, getRpcEntryIdentityKey(entries[1])), entries[1])
		assert.equal(getRpcEntryLabel(entries, entries[1]), 'Same name (https://second.example)')
	})

	test('distinguishes same-named chains sharing an RPC gateway', () => {
		const first = { name: 'Shared gateway', chainId: 1n, httpsRpc: 'https://shared.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const second = { ...first, chainId: 2n }
		const entries = [first, second]
		assert.equal(findRpcEntryByIdentityKey(entries, getRpcEntryIdentityKey(second)), second)
		assert.equal(getRpcEntryLabel(entries, second), 'Shared gateway (chain 2, https://shared.example)')
	})

	test('distinguishes RPC metadata variants without displaying API keys', () => {
		const first: RpcEntry = { name: 'Shared gateway', chainId: 1n, httpsRpc: 'https://shared.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false, blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: 'secret-first' } }
		const second = { ...first, blockExplorer: { ...first.blockExplorer, apiUrl: 'https://explorer.example/api', apiKey: 'secret-second' } }
		const third = { ...first, currencyTicker: 'OTHER', currencyName: 'Other currency' }
		const entries = [first, second, third]
		const labels = entries.map(entry => getRpcEntryLabel(entries, entry))
		assert.equal(new Set(labels).size, 3)
		assert.ok(labels.every(label => !label.includes('secret-')))
		assert.equal(labels[0], 'Shared gateway (ETH, Ether) (connection 1)')
		assert.equal(labels[1], 'Shared gateway (ETH, Ether) (connection 2)')
		assert.equal(labels[2], 'Shared gateway (OTHER, Other currency)')
		assert.equal(getRpcEntryLabel([first, second], first), 'Shared gateway (connection 1)')
		assert.equal(getRpcEntryLabel([first, second], second), 'Shared gateway (connection 2)')
	})

	test('redacts RPC URL credentials from selector labels', () => {
		const first: RpcEntry = { name: 'Private node', chainId: 1n, httpsRpc: 'https://alice:first-secret@node.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const second = { ...first, httpsRpc: 'https://bob:second-secret@node.example', primary: false }
		const publicNode = { ...first, httpsRpc: 'https://public.example', primary: false }
		assert.equal(getRpcEntryLabel([first, publicNode], first), 'Private node (https://***@node.example/)')
		assert.equal(getRpcEntryLabel([first, second, publicNode], first), 'Private node (https://***@node.example/) (connection 1)')
		assert.equal(getRpcEntryLabel([first, second, publicNode], second), 'Private node (https://***@node.example/) (connection 2)')
		assert.equal(getRpcEntryLabel([first, second, publicNode], publicNode), 'Private node (https://public.example)')
	})

	test('keeps dropdown controls from submitting surrounding forms', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<form><DropDownMenu selected = { signal('One') } dropDownOptions = { signal<readonly string[]>(['One', 'Two']) } onChangedCallBack = { () => undefined } buttonClassses = 'button-class' /></form>, dom.document.body)
			})

			const buttons = collectElements(dom.document.body, 'button')
			assert.equal(buttons.length, 3)
			assert.equal(buttons.every((button) => button.getAttribute?.('type') === 'button'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('combines a dropdown field label with its selected value', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<DropDownMenu selected = { signal('safe') } dropDownOptions = { signal<readonly string[]>(['safe']) } onChangedCallBack = { () => undefined } buttonClassses = 'button-class' ariaLabel = 'Address type' />, dom.document.body)
			})

			const trigger = collectElements(dom.document.body, 'button').find((button) => button.getAttribute?.('aria-haspopup') === 'true')
			assert.equal(trigger?.getAttribute?.('aria-label'), 'Address type: safe')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('gives each dropdown its own menu id and matching accessibility target', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<div>
					<DropDownMenu selected = { signal('One') } dropDownOptions = { signal<readonly string[]>(['One']) } onChangedCallBack = { () => undefined } buttonClassses = 'first-dropdown' />
					<DropDownMenu selected = { signal('Two') } dropDownOptions = { signal<readonly string[]>(['Two']) } onChangedCallBack = { () => undefined } buttonClassses = 'second-dropdown' />
				</div>, dom.document.body)
			})

			const menuIds = collectElements(dom.document.body, 'div')
				.filter((element) => element.getAttribute?.('role') === 'menu')
				.map((element) => element.getAttribute?.('id'))
			const controlledIds = collectElements(dom.document.body, 'button')
				.filter((element) => element.getAttribute?.('aria-haspopup') === 'true')
				.map((element) => element.getAttribute?.('aria-controls'))
			assert.equal(menuIds.length, 2)
			assert.equal(new Set(menuIds).size, 2)
			assert.deepEqual(controlledIds, menuIds)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('updates view content when active-view props change', async () => {
		const dom = installDomMock()
		const selector = (showParsed: boolean) => <ViewSelector id = 'dynamic-view'>
			<ViewSelector.List>
				<ViewSelector.View title = 'Parsed' value = 'parsed' isActive = { showParsed }>Parsed content</ViewSelector.View>
				<ViewSelector.View title = 'Raw' value = 'raw' isActive = { !showParsed }>Raw content</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</ViewSelector>
		try {
			await act(() => render(selector(false), dom.document.body))
			assert.equal(dom.document.body.textContent.includes('Raw content'), true)
			assert.equal(dom.document.body.textContent.includes('Parsed content'), false)

			await act(() => render(selector(true), dom.document.body))
			assert.equal(dom.document.body.textContent.includes('Parsed content'), true)
			assert.equal(dom.document.body.textContent.includes('Raw content'), false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('closes address removal only after the background mutation succeeds', async () => {
		const entry: AddressBookEntry = { type: 'contact', name: 'Test', address: 1n, entrySource: 'User', chainId: 1n, useAsActiveAddress: false, askForAddressAccess: true }
		let resolveRemoval = () => undefined
		const removal = new Promise<void>((resolve) => { resolveRemoval = resolve })
		let closeCount = 0
		const action = removeAddressBookEntryAndClose(async () => await removal, entry, () => { closeCount += 1 })

		await Promise.resolve()
		assert.equal(closeCount, 0)
		resolveRemoval()
		await action
		assert.equal(closeCount, 1)

		await assert.rejects(removeAddressBookEntryAndClose(async () => { throw new Error('remove failed') }, entry, () => { closeCount += 1 }), /remove failed/)
		assert.equal(closeCount, 1)
	})

	test('runs RPC dialog success cleanup only after a successful mutation', async () => {
		let cleanupCount = 0
		await completeRpcFormMutation(async () => undefined, () => { cleanupCount += 1 })
		assert.equal(cleanupCount, 1)
		await assert.rejects(completeRpcFormMutation(async () => { throw new Error('save failed') }, () => { cleanupCount += 1 }), /save failed/)
		assert.equal(cleanupCount, 1)
	})

	for (const operation of ['edit', 'remove', 'add'] as const) test(`RPC ${ operation } preserves other entries sharing its gateway`, async () => {
		const selected: RpcEntry = { name: 'Selected', chainId: 1n, httpsRpc: 'https://shared.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const peer = { ...selected, name: 'Same chain peer', primary: false }
		const otherChain = { ...selected, chainId: 2n }
		const entries = [selected, peer, otherChain]
		let persisted: RpcEntries | undefined
		const changes: RpcEntry[] = []
		const persist = async (value: RpcEntries) => { persisted = value }
		const change = async (value: RpcEntry) => { changes.push(value) }
		// List preferences may have changed since the active network snapshot was saved.
		const active = { ...selected, primary: false, minimized: true }
		const edited = { ...selected, name: 'Edited', httpsRpc: 'https://edited.example' }
		if (operation === 'remove') {
			await removeRpcEntryAndKeepActiveRpcConsistent(selected, entries, active, persist, change)
			assert.deepEqual(persisted, [peer, otherChain])
			assert.deepEqual(changes, [peer])
		} else if (operation === 'edit') {
			await saveRpcEntryAndKeepActiveRpcConsistent(edited, selected, entries, active, persist, change)
			assert.deepEqual(persisted, [edited, peer, otherChain])
			assert.deepEqual(changes, [edited])
		} else {
			const added = { ...selected, name: 'Added', primary: false }
			await saveRpcEntryAndKeepActiveRpcConsistent(added, undefined, entries, active, persist, change)
			assert.deepEqual(persisted, [...entries, added])
			assert.deepEqual(changes, [])
		}
	})

	test('rejects stale RPC edits and duplicate connections before persistence', async () => {
		const entry: RpcEntry = { name: 'Original', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const stale = { ...entry, name: 'Stale' }
		const unexpectedMutation = async () => { throw new Error('Unexpected mutation') }
		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent(entry, stale, [entry], entry, unexpectedMutation, unexpectedMutation), /Reopen the editor/)
		await assert.rejects(removeRpcEntryAndKeepActiveRpcConsistent(stale, [entry], entry, unexpectedMutation, unexpectedMutation), /Reopen the editor/)
		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent({ ...entry, primary: false }, undefined, [entry], entry, unexpectedMutation, unexpectedMutation), /identical RPC/)
	})

	test('does not broadcast an active RPC edit before its active-network update succeeds', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const editedRpc = { ...activeRpc, name: 'Edited active RPC' }
		const operations: string[] = []

		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent(editedRpc, activeRpc, [activeRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async () => {
				operations.push('change-active')
				throw new Error('active update failed')
			}
		), /active update failed/)
		assert.deepEqual(operations, ['change-active'])
	})

	test('does not treat an active RPC cross-chain edit as a completed signer switch', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const crossChainEdit = { ...activeRpc, chainId: 2n }
		const operations: string[] = []

		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent(crossChainEdit, activeRpc, [activeRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async () => { operations.push('change-active') }
		), /Switch to another RPC before changing/)
		assert.deepEqual(operations, [])
	})

	test('does not remove an active RPC before switching to its fallback succeeds', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const fallbackRpc = { ...activeRpc, name: 'Fallback', httpsRpc: 'https://fallback.example', primary: false }
		const operations: string[] = []

		await assert.rejects(removeRpcEntryAndKeepActiveRpcConsistent(activeRpc, [activeRpc, fallbackRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async (entry) => {
				operations.push(`change-active:${ entry.httpsRpc }`)
				throw new Error('fallback switch failed')
			}
		), /fallback switch failed/)
		assert.deepEqual(operations, [`change-active:${ fallbackRpc.httpsRpc }`])
	})

	for (const operation of ['edit', 'remove'] as const) {
		test(`keeps the RPC list and dialog intact when the background rejects an active RPC ${ operation }`, async () => {
			installBrowserMock()
			Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async () => ({ type: 'PopupSettingsChangeReply', ok: false, message: 'Another popup is changing settings.' }) })
			const active = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
			const fallback = { ...active, httpsRpc: 'https://fallback.example', primary: false }
			let persisted = false
			let closed = false
			const persist = async () => { persisted = true }
			const change = async (entry: typeof active) => await requestPopupSettingsChange({ method: 'popup_changeActiveRpc', data: entry })
			await assert.rejects(completeRpcFormMutation(async () => {
				if (operation === 'edit') await saveRpcEntryAndKeepActiveRpcConsistent({ ...active, name: 'Edited' }, active, [active, fallback], active, persist, change)
				else await removeRpcEntryAndKeepActiveRpcConsistent(active, [active, fallback], active, persist, change)
			}, () => { closed = true }), /Another popup/)
			assert.equal(persisted, false)
			assert.equal(closed, false)
		})
	}

	test('requires a confirmed same-chain fallback before removing an active RPC', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const crossChainRpc = { ...activeRpc, name: 'Other chain', chainId: 2n, httpsRpc: 'https://other-chain.example', primary: false }
		const operations: string[] = []

		await assert.rejects(removeRpcEntryAndKeepActiveRpcConsistent(activeRpc, [activeRpc, crossChainRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async () => { operations.push('change-active') }
		), /Switch to another RPC on this chain/)
		assert.deepEqual(operations, [])
	})

	test('awaits settings file reads and propagates import failures', async () => {
		let importedContents: string | undefined
		await readAndImportSettingsFile({ text: async () => '{"version": 1}' }, async (contents) => { importedContents = contents })
		assert.equal(importedContents, '{"version": 1}')
		await assert.rejects(readAndImportSettingsFile({ text: async () => { throw new Error('read failed') } }, async () => undefined), /read failed/)
	})

	test('revokes settings download object URLs after the click task', () => {
		const revokedUrls: string[] = []
		let cleanup = () => undefined
		const urlApi = {
			createObjectURL: () => 'blob:test-settings',
			revokeObjectURL: (url: string) => { revokedUrls.push(url) },
		}
		const usedUrl = withObjectUrl(new Blob(['settings']), (url) => url, urlApi, (scheduledCleanup) => { cleanup = scheduledCleanup })
		assert.equal(usedUrl, 'blob:test-settings')
		assert.deepEqual(revokedUrls, [])
		cleanup()
		assert.deepEqual(revokedUrls, ['blob:test-settings'])
	})

	test('preserves manual view selection across title-only updates', () => {
		let views = synchronizeViewConfig([], { title: 'Parsed', value: 'parsed', isActive: true }, 'activate')
		views = synchronizeViewConfig(views, { title: 'Raw', value: 'raw', isActive: false }, 'preserve')
		views = views.map(view => ({ ...view, isActive: view.value === 'raw' }))
		views = synchronizeViewConfig(views, { title: 'Decoded', value: 'parsed', isActive: true }, 'preserve')

		assert.equal(views.find(view => view.value === 'raw')?.isActive, true)
		assert.equal(views.find(view => view.value === 'parsed')?.isActive, false)
		assert.equal(views.find(view => view.value === 'parsed')?.title, 'Decoded')
	})

	test('renders warning details supplied by InlineCard callers', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<InlineCard icon = { () => <span>Token</span> } label = 'TKN' warningMessage = 'Untrusted address' noCopy noExpandButtons />, dom.document.body)
			})

			const warningSigns = collectElements(dom.document.body, 'span').filter((element) => element.getAttribute?.('role') === 'alert')
			assert.equal(warningSigns.length, 2)
			assert.equal(warningSigns.every((warningSign) => warningSign.getAttribute?.('title') === 'Untrusted address'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('parses and renders bigint delays without Number precision loss', async () => {
		const largeDelay = 9_007_199_254_740_993n
		assert.equal(parseTimePickerDeltaValue(largeDelay.toString()), largeDelay)
		assert.equal(parseTimePickerDeltaValue('1.5'), undefined)

		const dom = installDomMock()
		try {
			await act(() => {
				render(<TimePicker mode = { signal('For') } absoluteTime = { signal(undefined) } deltaValue = { signal(largeDelay) } deltaUnit = { signal('Seconds') } onChangedCallBack = { () => undefined } startText = 'Delay' removeNoDelayOption = { false } />, dom.document.body)
			})

			const numberInput = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')
			assert.equal(numberInput?.getAttribute?.('value'), largeDelay.toString())
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('requires a value before committing Until or For time picker modes', () => {
		assert.equal(hasValidTimePickerValue('Until', undefined, 1n), false)
		assert.equal(hasValidTimePickerValue('Until', new Date('2024-01-01T00:00:00.000Z'), undefined), true)
		assert.equal(hasValidTimePickerValue('For', undefined, undefined), false)
		assert.equal(hasValidTimePickerValue('For', undefined, 0n), true)
		assert.equal(hasValidTimePickerValue('No Delay', undefined, undefined), true)
	})

	test('decides once from the edited entry whether the RPC form adds or edits', () => {
		const storedEntry: RpcEntry = { name: 'Private node', chainId: 1n, httpsRpc: 'https://alice:s3cret@node.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		assert.deepEqual(getRpcFormMode(undefined), { kind: 'add' })
		assert.deepEqual(getRpcFormMode(storedEntry), { kind: 'edit', storedRpcUrl: 'https://alice:s3cret@node.example' })
	})

	test('saves the stored RPC URL in edit mode, even if URL text was submitted', () => {
		const formData = createRpcFormData('')
		formData.set('httpsRpc', 'https://***@node.example/')
		const parsed = parseRpcFormData(formData, { kind: 'edit', storedRpcUrl: 'https://alice:s3cret@node.example' })

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.equal(parsed.value.httpsRpc, 'https://alice:s3cret@node.example')
	})

	test('saves the typed RPC URL in add mode', () => {
		const formData = createRpcFormData('')
		formData.set('httpsRpc', ' https://alice:s3cret@node.example ')
		const parsed = parseRpcFormData(formData, { kind: 'add' })

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.equal(parsed.value.httpsRpc, 'https://alice:s3cret@node.example')
	})

	test('saves the stored credentialed URL when the rendered edit form is submitted', async () => {
		const storedEntry: RpcEntry = { name: 'Private node', chainId: 1n, httpsRpc: 'https://alice:s3cret@node.example/v1', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const { savedEntries, formClosed } = await renderAndSaveRpcForm(storedEntry, (inputs) => {
			const urlInput = findInput(inputs, 'placeholder', 'RPC URL *')
			assert.equal(urlInput.getAttribute?.('defaultValue'), 'https://***@node.example/v1')
			assert.equal(urlInput.getAttribute?.('name'), null)
			assert.notEqual(urlInput.getAttribute?.('readOnly'), null)
			findInput(inputs, 'name', 'name').value = 'Renamed node'
		})

		assert.equal(formClosed, true)
		assert.deepEqual(savedEntries.map((entry) => ({ name: entry.name, httpsRpc: entry.httpsRpc })), [{ name: 'Renamed node', httpsRpc: storedEntry.httpsRpc }])
	})

	test('saves the typed credentialed URL when the rendered add form is submitted', async () => {
		const typedRpcUrl = 'https://alice:s3cret@node.example'
		const { savedEntries, formClosed } = await renderAndSaveRpcForm(undefined, (inputs) => {
			const urlInput = findInput(inputs, 'placeholder', 'RPC URL *')
			assert.equal(urlInput.getAttribute?.('name'), 'httpsRpc')
			assert.equal(urlInput.getAttribute?.('readOnly'), null)
			urlInput.value = typedRpcUrl
			findInput(inputs, 'name', 'name').value = 'Private node'
			findInput(inputs, 'name', 'chainId').value = '1'
			findInput(inputs, 'name', 'currencyName').value = 'Ether'
			findInput(inputs, 'name', 'currencyTicker').value = 'ETH'
		})

		assert.equal(formClosed, true)
		assert.deepEqual(savedEntries.map((entry) => ({ name: entry.name, chainId: entry.chainId, httpsRpc: entry.httpsRpc })), [{ name: 'Private node', chainId: 1n, httpsRpc: typedRpcUrl }])
	})

	test('rejects saving a typed credential URL that would be sent over plaintext http to a remote host', async () => {
		const typedRpcUrl = 'http://alice:s3cret@remote-node:8545'
		const expectedError = 'Credentials in RPC URL http://***@remote-node:8545/ can only be sent over https, or over http to localhost.'
		const urlFieldValidityMessages: string[] = []
		const { savedEntries, formClosed, fetchCalls, renderedText } = await renderAndSaveRpcForm(undefined, async (inputs) => {
			const urlInput = findInput(inputs, 'placeholder', 'RPC URL *')
			urlInput.setCustomValidity = (message) => { urlFieldValidityMessages.push(message) }
			await typeIntoInput(urlInput, typedRpcUrl)
			await waitForRenderedState(() => urlFieldValidityMessages.at(-1) === expectedError)
			// Filling every other field, as a probe of a previously typed URL would, leaves the credential check as the only reason not to save.
			findInput(inputs, 'name', 'name').value = 'Private node'
			findInput(inputs, 'name', 'chainId').value = '1'
			findInput(inputs, 'name', 'currencyName').value = 'Ether'
			findInput(inputs, 'name', 'currencyTicker').value = 'ETH'
		})

		assert.equal(urlFieldValidityMessages.at(-1), expectedError)
		assert.equal(fetchCalls, 0)
		assert.equal(formClosed, false)
		assert.deepEqual(savedEntries, [])
		assert.equal(renderedText.includes(expectedError), true)
		assert.equal(renderedText.includes('s3cret'), false)
	})

	test('rejects saving an edited entry whose stored URL would send credentials over plaintext http to a remote host', async () => {
		const importedEntry: RpcEntry = { name: 'Imported node', chainId: 1n, httpsRpc: 'http://alice:s3cret@remote-node:8545', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const { savedEntries, formClosed, renderedText } = await renderAndSaveRpcForm(importedEntry, (inputs) => {
			findInput(inputs, 'name', 'name').value = 'Renamed node'
		})

		assert.equal(formClosed, false)
		assert.deepEqual(savedEntries, [])
		assert.equal(renderedText.includes('Credentials in RPC URL http://***@remote-node:8545/ can only be sent over https, or over http to localhost.'), true)
	})

	test('keeps a block explorer URL when its API key is empty', () => {
		const parsed = parseRpcFormData(createRpcFormData(''), { kind: 'add' })

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.deepEqual(parsed.value.blockExplorer, { apiUrl: 'https://explorer.example/api', apiKey: '' })
	})
})
