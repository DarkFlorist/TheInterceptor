import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { ModifyAddressWindowState } from '../../app/ts/types/visualizer-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'

const checksummedAddress = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'
const badChecksumAddress = '0xaB5801a7D398351b8bE11C439e05C5B3259aeC9B'
const addressValue = 0xab5801a7d398351b8be11c439e05c5b3259aec9bn
const otherAddress = '0x0000000000000000000000000000000000000123'
const chainPrefixIssue = 'Chain prefix must be an EIP-3770 short name followed directly by the address (e.g. eth:0x...).'

const rpcEntry: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://rpc.example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentRuntimeMessages: unknown[] = []
	defineGlobal('browser', {
		runtime: {
			lastError: undefined,
			async sendMessage(message: unknown) {
				sentRuntimeMessages.push(message)
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
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
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
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
	})
	defineGlobal('chrome', { runtime: { id: 'test-extension' } })
	return sentRuntimeMessages
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/metadataSearch.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/simulation/services/EthereumClientService.js'),
		...await import('../../app/ts/types/interceptor-messages.js'),
	}
}

type Modules = Awaited<ReturnType<typeof loadModules>>

function createEthereumClient(modules: Modules, requestedCodeAddresses: bigint[]) {
	const requestHandler = {
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => rpcEntry.chainId,
		jsonRpcRequest: async (rpcRequest: EthereumJsonRpcRequest) => {
			if (rpcRequest.method !== 'eth_getCode') throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			requestedCodeAddresses.push(rpcRequest.params[0])
			return '0x'
		},
	}
	return new modules.EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)
}

function createContactEntry(address: bigint, name: string): ContactEntry {
	return { type: 'contact', name, address, entrySource: 'User', chainId: 1n, askForAddressAccess: true, useAsActiveAddress: false }
}

function createAddingContactWindowState(address: string): ModifyAddressWindowState {
	return {
		windowStateId: 'eip3770-background-window',
		errorState: undefined,
		incompleteAddressBookEntry: {
			addingAddress: true,
			type: 'contact',
			address,
			askForAddressAccess: true,
			name: 'EIP-3770 pasted contact',
			symbol: undefined,
			decimals: undefined,
			logoUri: undefined,
			entrySource: 'User',
			abi: undefined,
			useAsActiveAddress: undefined,
			declarativeNetRequestBlockMode: undefined,
			chainId: 1n,
		},
	}
}

async function validateAddressWindowState(address: string) {
	const sentRuntimeMessages = installBrowserMock()
	const modules = await loadModules()
	await modules.updateUserAddressBookEntries(() => [createContactEntry(0x1111111111111111111111111111111111111111n, 'Existing contact')])
	const requestedCodeAddresses: bigint[] = []
	const newState = createAddingContactWindowState(address)
	await modules.changeAddOrModifyAddressWindowState(createEthereumClient(modules, requestedCodeAddresses), {
		method: 'popup_changeAddOrModifyAddressWindowState',
		data: { windowStateId: newState.windowStateId, newState },
	})
	const errorStates = sentRuntimeMessages.map((message) => modules.MessageToPopup.parse(message)).flatMap((message) => message.method === 'popup_addOrModifyAddressWindowStateInformation' ? [message.data.errorState] : [])
	return { errorStates, requestedCodeAddresses }
}

describe('background handling of user-entered EIP-3770 addresses', () => {
	test('validates a chain-specific address in the address-book editor without errors', async () => {
		const { errorStates, requestedCodeAddresses } = await validateAddressWindowState(` eth:${ checksummedAddress } `)
		assert.deepEqual(errorStates, [undefined])
		assert.deepEqual(requestedCodeAddresses, [addressValue])
	})

	test('reports the checksum suggestion for a chain-specific address with a bad checksum', async () => {
		const { errorStates, requestedCodeAddresses } = await validateAddressWindowState(`eth:${ badChecksumAddress }`)
		assert.deepEqual(errorStates, [{ blockEditing: true, message: `Bad address checksum, did you mean ${ checksummedAddress } ?` }])
		assert.deepEqual(requestedCodeAddresses, [])
	})

	test('rejects a chain-specific address whose short name names another chain than the entry', async () => {
		const { errorStates, requestedCodeAddresses } = await validateAddressWindowState(`gno:${ checksummedAddress }`)
		assert.deepEqual(errorStates, [{ blockEditing: true, message: 'This address is for Gnosis (gno:), but this entry is for Ethereum Mainnet.' }])
		assert.deepEqual(requestedCodeAddresses, [])
	})

	test('reports an unsupported chain prefix form instead of the address length', async () => {
		const { errorStates } = await validateAddressWindowState(`eth: ${ checksummedAddress }`)
		assert.deepEqual(errorStates, [{ blockEditing: true, message: chainPrefixIssue }])
	})

	test('rejects an address-like chain prefix instead of validating the address after it', async () => {
		for (const prefix of [`0X${ checksummedAddress.slice(2) }`, checksummedAddress.slice(2), checksummedAddress.slice(2).toLowerCase()]) {
			const { errorStates, requestedCodeAddresses } = await validateAddressWindowState(`${ prefix }:${ otherAddress }`)
			assert.deepEqual(errorStates, [{ blockEditing: true, message: chainPrefixIssue }], prefix)
			assert.deepEqual(requestedCodeAddresses, [], prefix)
		}
	})

	test('finds address-book entries by a pasted chain-specific address', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const searchedContact = createContactEntry(addressValue, 'Searched contact')
		await modules.updateUserAddressBookEntries(() => [
			createContactEntry(0x1111111111111111111111111111111111111111n, 'Other contact'),
			searchedContact,
		])
		const searchContacts = async (searchString: string) => await modules.getMetadataForAddressBookData({ filter: 'My Contacts', chainId: 1n, searchString, startIndex: 0, maxIndex: 10 })

		const prefixedSearchResult = await searchContacts(`eth:${ checksummedAddress }`)
		assert.deepEqual(prefixedSearchResult, await searchContacts(checksummedAddress))
		assert.deepEqual(prefixedSearchResult, { entries: [searchedContact], maxDataLength: 1 })
	})
})
