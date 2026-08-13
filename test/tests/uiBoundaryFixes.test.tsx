import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { findChainEntryByName, findRpcEntryByUrl, getRpcEntryLabel } from '../../app/ts/components/subcomponents/ChainSelector.js'
import { DropDownMenu } from '../../app/ts/components/subcomponents/DropDownMenu.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { hasValidTimePickerValue, parseTimePickerDeltaValue, TimePicker } from '../../app/ts/components/subcomponents/TimePicker.js'
import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../../app/ts/components/ui-utils.js'
import { parseRpcFormData } from '../../app/ts/utils/rpcFormData.js'
import { removeAddressBookEntryAndClose } from '../../app/ts/AddressBook.js'
import { completeRpcFormMutation, removeRpcEntryAndKeepActiveRpcConsistent, saveRpcEntryAndKeepActiveRpcConsistent } from '../../app/ts/components/subcomponents/ConfigureRpcConnection.js'
import { readAndImportSettingsFile, withObjectUrl } from '../../app/ts/components/pages/SettingsView.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { installDomMock } from './domMock.js'
import { synchronizeViewConfig, ViewSelector } from '../../app/ts/components/subcomponents/ViewSelector.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
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

		assert.equal(findRpcEntryByUrl(entries, 'https://second.example'), entries[1])
		assert.equal(getRpcEntryLabel(entries, 'https://second.example'), 'Same name (https://second.example)')
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

	test('does not broadcast an active RPC edit before its active-network update succeeds', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const editedRpc = { ...activeRpc, name: 'Edited active RPC' }
		const operations: string[] = []

		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent(editedRpc, [activeRpc], activeRpc,
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

		await assert.rejects(saveRpcEntryAndKeepActiveRpcConsistent(crossChainEdit, [activeRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async () => { operations.push('change-active') }
		), /Switch to another RPC before changing/)
		assert.deepEqual(operations, [])
	})

	test('does not remove an active RPC before switching to its fallback succeeds', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const fallbackRpc = { ...activeRpc, name: 'Fallback', httpsRpc: 'https://fallback.example', primary: false }
		const operations: string[] = []

		await assert.rejects(removeRpcEntryAndKeepActiveRpcConsistent(activeRpc.httpsRpc, [activeRpc, fallbackRpc], activeRpc,
			async () => { operations.push('persist-list') },
			async (entry) => {
				operations.push(`change-active:${ entry.httpsRpc }`)
				throw new Error('fallback switch failed')
			}
		), /fallback switch failed/)
		assert.deepEqual(operations, [`change-active:${ fallbackRpc.httpsRpc }`])
	})

	test('requires a confirmed same-chain fallback before removing an active RPC', async () => {
		const activeRpc = { name: 'Active', chainId: 1n, httpsRpc: 'https://active.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const crossChainRpc = { ...activeRpc, name: 'Other chain', chainId: 2n, httpsRpc: 'https://other-chain.example', primary: false }
		const operations: string[] = []

		await assert.rejects(removeRpcEntryAndKeepActiveRpcConsistent(activeRpc.httpsRpc, [activeRpc, crossChainRpc], activeRpc,
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

	test('keeps a block explorer URL when its API key is empty', () => {
		const parsed = parseRpcFormData(createRpcFormData(''))

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.deepEqual(parsed.value.blockExplorer, { apiUrl: 'https://explorer.example/api', apiKey: '' })
	})
})
