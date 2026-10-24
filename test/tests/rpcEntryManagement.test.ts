import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { findChainEntryByName, findRpcEntryByIdentityKey, getRpcEntryLabel } from '../../app/ts/components/subcomponents/ChainSelector.js'
import { completeRpcFormMutation, removeRpcEntryAndKeepActiveRpcConsistent, saveRpcEntryAndKeepActiveRpcConsistent } from '../../app/ts/components/subcomponents/ConfigureRpcConnection.js'
import { requestPopupSettingsChange } from '../../app/ts/components/popupSettingsChange.js'
import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../../app/ts/components/ui-utils.js'
import type { RpcEntries, RpcEntry } from '../../app/ts/types/rpc.js'
import { parseRpcFormData } from '../../app/ts/utils/rpcFormData.js'
import { getRpcEntryIdentityKey } from '../../app/ts/utils/rpcNetworkChange.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

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

describe('RPC entry selection, labels and consistent edits', () => {
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
			installBrowserMock({ handlers: { runtimeMessage: async () => ({ type: 'PopupSettingsChangeReply', ok: false, message: 'Another popup is changing settings.' }) } })
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

	test('keeps a block explorer URL when its API key is empty', () => {
		const parsed = parseRpcFormData(createRpcFormData(''))

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.deepEqual(parsed.value.blockExplorer, { apiUrl: 'https://explorer.example/api', apiKey: '' })
	})
})
