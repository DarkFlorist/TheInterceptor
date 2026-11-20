import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, bigintToUint8Array, checksummedAddress } from '../../app/ts/utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import { RichToken } from '../../app/ts/types/richMode.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import type { ResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { AddressBookEntry, type Erc1155Entry } from '../../app/ts/types/addressBookTypes.js'

const richAccountAddress = 0x1111111111111111111111111111111111111111n

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock(options: { onRuntimeSendMessage?: (message: unknown) => void, onStorageGet?: (keys: unknown) => void, onStorageSet?: (items: Record<string, unknown>) => void | Promise<void> } = {}) {
	const storageState: Record<string, unknown> = {}
	defineGlobal('browser', {
		runtime: {
			lastError: null,
			async sendMessage(message: unknown) {
				options.onRuntimeSendMessage?.(message)
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					options.onStorageGet?.(keys)
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					await options.onStorageSet?.(items)
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
	})
	defineGlobal('chrome', { runtime: { id: 'test-extension' } })
	return storageState
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/richModeSettings.js'),
		...await import('../../app/ts/background/richModeTokens.js'),
		...await import('../../app/ts/background/richModeMigration.js'),
		...await import('../../app/ts/background/windows/watchAsset.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/simulationUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/windows/fetchSimulationStack.js'),
	}
}

async function withSilencedConsole<T>(runWithConsoleSilenced: () => Promise<T>) {
	const originalConsole = {
		error: console.error,
		trace: console.trace,
		warn: console.warn,
	}
	console.error = () => undefined
	console.trace = () => undefined
	console.warn = () => undefined
	try {
		return await runWithConsoleSilenced()
	} finally {
		console.error = originalConsole.error
		console.trace = originalConsole.trace
		console.warn = originalConsole.warn
	}
}

const successfulBalanceCall = (balance: bigint) => ({
	number: 1n,
	hash: 1n,
	timestamp: 1n,
	gasLimit: 30_000_000n,
	gasUsed: 10_000n,
	baseFeePerGas: 1n,
	calls: [{
		status: 'success' as const,
		returnData: bigintToUint8Array(balance, 32),
		gasUsed: 10_000n,
		logs: [],
	}],
})

describe('requestMakeMeRichList resilience', () => {
	test('writes fixed rich-list storage only when content or ordering changes', async () => {
		let fixedRichListWriteCount = 0
		installBrowserMock({ onStorageSet: (items) => {
			if ('richModeState' in items) fixedRichListWriteCount += 1
		} })
		const { setFixedMakeMeRichList, updateFixedMakeMeRichList } = await loadModules()
		const address = 0x1000000000000000000000000000000000000001n
		const otherAddress = 0x2000000000000000000000000000000000000002n
		const initialList = [
			{ address, makingRich: true, type: 'UserAdded' as const },
			{ address: otherAddress, makingRich: false, type: 'PreviousActiveAddress' as const },
		]

		await setFixedMakeMeRichList(initialList)
		fixedRichListWriteCount = 0
		assert.equal(await updateFixedMakeMeRichList((currentList) => currentList.map((element) => ({ ...element }))), false)
		assert.equal(fixedRichListWriteCount, 0)

		await setFixedMakeMeRichList(initialList)
		fixedRichListWriteCount = 0
		assert.equal(await updateFixedMakeMeRichList((currentList) => currentList.map((element, index) => index === 0 ? { ...element, address: otherAddress } : element)), true)
		assert.equal(fixedRichListWriteCount, 1)

		await setFixedMakeMeRichList(initialList)
		fixedRichListWriteCount = 0
		assert.equal(await updateFixedMakeMeRichList((currentList) => currentList.map((element, index) => index === 0 ? { ...element, makingRich: false } : element)), true)
		assert.equal(fixedRichListWriteCount, 1)

		await setFixedMakeMeRichList(initialList)
		fixedRichListWriteCount = 0
		assert.equal(await updateFixedMakeMeRichList((currentList) => currentList.map((element, index) => index === 0 ? { ...element, type: 'PreviousActiveAddress' as const } : element)), true)
		assert.equal(fixedRichListWriteCount, 1)

		await setFixedMakeMeRichList(initialList)
		fixedRichListWriteCount = 0
		assert.equal(await updateFixedMakeMeRichList((currentList) => [...currentList].reverse()), true)
		assert.equal(fixedRichListWriteCount, 1)
	})

	test('serializes rapid rich-list changes without duplicating addresses', async () => {
		const storageState = installBrowserMock()
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList } = await loadModules()
		const address = 0x2000000000000000000000000000000000000002n

		await setFixedMakeMeRichList([])
		await Promise.all([
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
		])

		assert.deepEqual(await getFixedAddressRichList(), [{ address, makingRich: true, type: 'UserAdded' }])
		assert.equal(Object.hasOwn(storageState, 'fixedAddressRichList'), false)
	})

	test('preserves user rich-list changes during previous active address tracking', async () => {
		installBrowserMock()
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList, trackPreviousActiveAddressForMakeMeRichList } = await loadModules()
		const userAddedAddress = 0x3000000000000000000000000000000000000003n
		const previousActiveAddress = 0x4000000000000000000000000000000000000004n

		await setFixedMakeMeRichList([])
		await Promise.all([
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: userAddedAddress } }),
			trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress),
		])

		assert.deepEqual(await getFixedAddressRichList(), [
			{ address: userAddedAddress, makingRich: true, type: 'UserAdded' },
			{ address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
	})

	test('skips popup visualisation refresh when current-address rich setting changes', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, getMakeCurrentAddressRich } = await loadModules()

		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })

		assert.equal(await getMakeCurrentAddressRich(), true)
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('keeps existing rich address position and skips refresh when adding it again', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList } = await loadModules()
		const existingAddress = 0x5000000000000000000000000000000000000005n
		const laterAddress = 0x6000000000000000000000000000000000000006n

		await setFixedMakeMeRichList([
			{ address: existingAddress, makingRich: true, type: 'UserAdded' },
			{ address: laterAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: existingAddress } })

		assert.deepEqual(await getFixedAddressRichList(), [
			{ address: existingAddress, makingRich: true, type: 'UserAdded' },
			{ address: laterAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('includes changed rich addresses in the next simulation input without a popup refresh', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, getCurrentSimulationInput } = await loadModules()
		const richAddress = 0x7000000000000000000000000000000000000007n

		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: richAddress } })

		const simulationInput = await getCurrentSimulationInput()
		assert.deepEqual(simulationInput[0]?.stateOverrides[addressString(richAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('includes current-address rich mode in the next simulation input without a popup refresh', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, changeSimulationMode, getCurrentSimulationInput } = await loadModules()
		const activeAddress = 0x8000000000000000000000000000000000000008n

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })

		const simulationInput = await getCurrentSimulationInput()
		assert.deepEqual(simulationInput[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('uses the configured native rich amount in the next simulation input', async () => {
		installBrowserMock()
		const { modifyMakeMeRich, getCurrentSimulationInput } = await loadModules()
		const richAddress = 0x9000000000000000000000000000000000000009n
		const configuredAmount = 12_345_678_000_000_000_000n

		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: richAddress } })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: configuredAmount, address: richAddress } })

		const simulationInput = await getCurrentSimulationInput()
		assert.deepEqual(simulationInput[0]?.stateOverrides[addressString(richAddress)], { balance: configuredAmount })
	})

	test('uses the account native amount in legacy simulation stack output', async () => {
		installBrowserMock()
		const { changeSimulationMode, getSimulationStack, modifyMakeMeRich } = await loadModules()
		const configuredAmount = 9_876_543_210_000_000_000n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: richAccountAddress })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: configuredAmount, address: richAccountAddress } })
		const simulationState: ResolvedSimulationState = {
			kind: 'simulated',
			value: {
				success: true,
				simulationStateInput: [],
				simulatedBlocks: [],
				blockNumber: 1n,
				blockTimestamp: new Date('2026-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				simulationConductedTimestamp: new Date('2026-01-01T00:00:00.000Z'),
				rpcNetwork: {
					name: 'Ethereum',
					chainId: 1n,
					httpsRpc: 'https://example.invalid',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					primary: true,
					minimized: false,
				},
			},
		}

		const stack = await getSimulationStack(simulationState, '1.0.1')
		assert.equal(stack.payload[0]?.value, configuredAmount)
		assert.deepEqual(stack.payload[0]?.balanceChanges, [{ address: richAccountAddress, before: 0n, after: configuredAmount }])
	})

	test('computes simulation defaults without writing storage or reading the address book', async () => {
		let writes = 0
		let addressBookReads = 0
		installBrowserMock({
			onStorageSet: () => { writes += 1 },
			onStorageGet: (keys) => {
				if (keys === 'userAddressBookEntriesV3' || (Array.isArray(keys) && keys.includes('userAddressBookEntriesV3'))) addressBookReads += 1
			},
		})
		const { getCurrentSimulationInput, getSettings } = await loadModules()
		const settings = await getSettings()
		writes = 0
		const input = await getCurrentSimulationInput([richAccountAddress], settings)
		assert.equal(input[0]?.stateOverrides[addressString(richAccountAddress)]?.balance, MAKE_YOU_RICH_TRANSACTION.transaction.value)
		assert.equal(writes, 0)
		assert.equal(addressBookReads, 0)
	})

	test('stores funding amounts only in account profiles and preserves layout metadata across amount edits', async () => {
		const storageState = installBrowserMock()
		const { getRichModeState, modifyMakeMeRich, updateRichTokens, updateRichAccountBalances } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		await updateRichTokens(() => [{ chainId: 1n, tokenAddress, tokenType: 'ERC20', tokenId: undefined, name: 'USD Coin', symbol: 'USDC', decimals: 6n, amount: 999n, balanceSlot: 9n, erc1155StorageOrder: undefined }])
		await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 123n, tokenBalances: [{ tokenAddress, tokenId: undefined, amount: 456n }] }])
		const before = await getRichModeState()
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { address: richAccountAddress, nativeAmount: 789n } })
		const after = await getRichModeState()
		assert.deepEqual(after.tokenLayouts, before.tokenLayouts)
		assert.equal(Object.hasOwn(after.tokenLayouts[0] ?? {}, 'amount'), false)
		assert.equal(after.accountBalances[0]?.nativeAmount, 789n)
		assert.equal(after.accountBalances[0]?.tokenBalances[0]?.amount, 456n)
		for (const key of ['makeCurrentAddressRich', 'fixedAddressRichList', 'richNativeAmount', 'richTokens', 'richAccountBalances']) assert.equal(Object.hasOwn(storageState, key), false)
	})

	test('refreshes cached token metadata without changing saved balances and uses corrected defaults for another account', async () => {
		const storageState = installBrowserMock()
		const { getRichModeState, modifyRichToken, mutateRichMode, updateRichTokens, updateRichAccountBalances } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		const secondAccount = 0x2222222222222222222222222222222222222222n
		storageState.userAddressBookEntriesV3 = [{ type: 'ERC20', address: addressString(tokenAddress), name: 'Original token', symbol: 'OLD', decimals: '0x12', entrySource: 'User', chainId: '0x1' }]
		await updateRichTokens(() => [{ chainId: 1n, tokenAddress, tokenType: 'ERC20', tokenId: undefined, name: 'Original token', symbol: 'OLD', decimals: 18n, amount: 200_000n * 10n ** 18n, balanceSlot: 9n, erc1155StorageOrder: undefined }])
		await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 123n, tokenBalances: [{ tokenAddress, tokenId: undefined, amount: 456n }] }])

		const fundingChanged = await mutateRichMode(async (store) => await store.updateAddressBook((entries) => entries.map((entry) => entry.type === 'ERC20'
			? { ...entry, name: 'USD Coin', symbol: 'USDC', decimals: 6n }
			: entry)))
		assert.equal(fundingChanged, false)
		const updated = await getRichModeState()
		assert.equal(updated.tokenLayouts[0]?.name, 'USD Coin')
		assert.equal(updated.tokenLayouts[0]?.symbol, 'USDC')
		assert.equal(updated.tokenLayouts[0]?.decimals, 6n)
		assert.equal(updated.tokenLayouts[0]?.balanceSlot, 9n)
		assert.deepEqual(updated.accountBalances, [{ chainId: 1n, address: richAccountAddress, nativeAmount: 123n, tokenBalances: [{ tokenAddress, tokenId: undefined, amount: 456n }] }])

		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
			name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
		})
		let probeCount = 0
		Object.defineProperty(ethereum, 'ethSimulateV1', { value: async () => { probeCount += 1; throw new Error('A cached layout should not need another storage probe') } })
		const reply = await modifyRichToken(ethereum, undefined, { method: 'popup_modifyRichToken', data: { action: 'Add', address: secondAccount, tokenAddress } })
		assert.equal(reply.result.success, true)
		if (!reply.result.success) throw new Error(reply.result.error)
		assert.equal(reply.result.richToken?.name, 'USD Coin')
		assert.equal(reply.result.richToken?.symbol, 'USDC')
		assert.equal(reply.result.richToken?.decimals, 6n)
		assert.equal(reply.result.richToken?.balanceSlot, 9n)
		assert.equal(reply.result.richToken?.amount, 200_000_000_000n)
		assert.equal(probeCount, 0)
		const saved = await getRichModeState()
		assert.equal(saved.accountBalances.find((profile) => profile.address === secondAccount)?.tokenBalances[0]?.amount, 200_000_000_000n)
		assert.equal(saved.accountBalances.find((profile) => profile.address === richAccountAddress)?.tokenBalances[0]?.amount, 456n)
	})

	test('reports funding changes when watched IDs or their address-book entry are removed', async () => {
		const storageState = installBrowserMock()
		const { getRichModeState, mutateRichMode, updateRichTokens, updateRichAccountBalances } = await loadModules()
		const tokenAddress = 0x3333333333333333333333333333333333333333n
		storageState.userAddressBookEntriesV3 = [{ type: 'ERC1155', address: addressString(tokenAddress), name: 'Collectibles', symbol: 'NFT', entrySource: 'User', chainId: '0x1', watchedTokenIds: ['0x7', '0x8'] }]
		await updateRichTokens(() => [7n, 8n].map((tokenId) => ({ chainId: 1n, tokenAddress, tokenType: 'ERC1155', tokenId, name: 'Collectibles', symbol: 'NFT', decimals: 0n, amount: 200_000n, balanceSlot: 2n, erc1155StorageOrder: 'TokenIdThenOwner' })))
		await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 123n, tokenBalances: [{ tokenAddress, tokenId: 7n, amount: 12n }, { tokenAddress, tokenId: 8n, amount: 34n }] }])

		const unwatched = await mutateRichMode(async (store) => await store.updateAddressBook((entries) => entries.map((entry) => entry.type === 'ERC1155' ? { ...entry, watchedTokenIds: [8n] } : entry)))
		assert.equal(unwatched, true)
		const afterUnwatch = await getRichModeState()
		assert.deepEqual(afterUnwatch.tokenLayouts.map((token) => token.tokenId), [8n])
		assert.deepEqual(afterUnwatch.accountBalances[0]?.tokenBalances, [{ tokenAddress, tokenId: 8n, amount: 34n }])
		assert.equal(await mutateRichMode(async (store) => await store.updateAddressBook((entries) => entries)), false)

		assert.equal(await mutateRichMode(async (store) => await store.updateAddressBook(() => [])), true)
		const afterRemoval = await getRichModeState()
		assert.deepEqual(afterRemoval.tokenLayouts, [])
		assert.deepEqual(afterRemoval.accountBalances[0]?.tokenBalances, [])
		assert.equal(afterRemoval.accountBalances[0]?.nativeAmount, 123n)
	})

	const legacyToken = (chainId: bigint, tokenAddress: bigint, amount: bigint) => serialize(RichToken, {
		chainId, tokenAddress, tokenType: 'ERC20', tokenId: undefined, name: 'Legacy Token', symbol: 'OLD', decimals: 6n, amount, balanceSlot: 9n, erc1155StorageOrder: undefined,
	})
	const legacyKeys = ['makeCurrentAddressRich', 'fixedAddressRichList', 'richNativeAmount', 'richTokens', 'richAccountBalances']

	test('migrates legacy token amounts to every address that can be made rich, so an address made rich later keeps them', async () => {
		const storageState = installBrowserMock()
		const { migrateRichMode, ensureRichAccountBalances, getRichModeState } = await loadModules()
		const mainnetToken = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		const optimismToken = 0x4200000000000000000000000000000000000042n
		const fixedAddress = 0x2222222222222222222222222222222222222222n
		const addressBookAccount = 0x3333333333333333333333333333333333333333n
		const unknownAddress = 0x4444444444444444444444444444444444444444n
		storageState.independentActiveSimulationAddress = addressString(richAccountAddress)
		storageState.userAddressBookEntriesV3 = [{ type: 'contact', name: 'Later rich account', address: addressString(addressBookAccount), entrySource: 'User', useAsActiveAddress: true }]
		storageState.makeCurrentAddressRich = false
		storageState.fixedAddressRichList = [{ address: checksummedAddress(fixedAddress), makingRich: false, type: 'UserAdded' }]
		storageState.richNativeAmount = '0x7'
		storageState.richTokens = [legacyToken(1n, mainnetToken, 1_000n), legacyToken(10n, optimismToken, 2_000n)]

		await migrateRichMode()
		for (const key of legacyKeys) assert.equal(Object.hasOwn(storageState, key), false)
		const migrated = await getRichModeState()
		assert.equal(migrated.defaultNativeAmount, 7n)
		for (const address of [richAccountAddress, fixedAddress, addressBookAccount]) {
			assert.deepEqual(migrated.accountBalances.find((profile) => profile.chainId === 1n && profile.address === address)?.tokenBalances, [{ tokenAddress: mainnetToken, tokenId: undefined, amount: 1_000n }])
			assert.deepEqual(migrated.accountBalances.find((profile) => profile.chainId === 10n && profile.address === address)?.tokenBalances, [{ tokenAddress: optimismToken, tokenId: undefined, amount: 2_000n }])
		}

		const madeRichLater = await ensureRichAccountBalances(1n, [addressBookAccount, unknownAddress])
		assert.deepEqual(madeRichLater.find((profile) => profile.chainId === 1n && profile.address === addressBookAccount)?.tokenBalances, [{ tokenAddress: mainnetToken, tokenId: undefined, amount: 1_000n }])
		assert.deepEqual(madeRichLater.find((profile) => profile.chainId === 1n && profile.address === unknownAddress)?.tokenBalances, [])
	})

	test('keeps legacy per-account profiles as they are and treats corrupt ones as none', async () => {
		const storageState = installBrowserMock()
		const { migrateRichMode, getRichModeState } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.richTokens = [legacyToken(1n, tokenAddress, 1_000n)]
		storageState.richAccountBalances = [{ chainId: '0x1', address: addressString(richAccountAddress), nativeAmount: '0x5', tokenBalances: [{ tokenAddress: addressString(tokenAddress), tokenId: undefined, amount: '0x9' }] }]
		await migrateRichMode()
		assert.deepEqual((await getRichModeState()).accountBalances, [{ chainId: 1n, address: richAccountAddress, nativeAmount: 5n, tokenBalances: [{ tokenAddress, tokenId: undefined, amount: 9n }] }])

		const corruptStorage = installBrowserMock()
		const corrupt = await loadModules()
		corruptStorage.richTokens = [legacyToken(1n, tokenAddress, 1_000n)]
		corruptStorage.richAccountBalances = null
		await withSilencedConsole(async () => await corrupt.migrateRichMode())
		assert.deepEqual((await corrupt.getRichModeState()).accountBalances, [])
		assert.equal(Object.hasOwn(corruptStorage, 'richAccountBalances'), false)
	})

	test('reads never migrate or write, and migration keeps existing canonical state', async () => {
		const writtenKeys: string[] = []
		const storageState = installBrowserMock({ onStorageSet: (items) => { writtenKeys.push(...Object.keys(items)) } })
		const { migrateRichMode, getRichModeState, getMakeCurrentAddressRich, setMakeCurrentAddressRich } = await loadModules()
		storageState.makeCurrentAddressRich = true
		storageState.richTokens = [legacyToken(1n, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, 1_000n)]
		const first = await getRichModeState()
		assert.deepEqual(await getRichModeState(), first)
		assert.equal(await getMakeCurrentAddressRich(), false)
		assert.deepEqual(writtenKeys, [])
		assert.equal(Object.hasOwn(storageState, 'richTokens'), true)

		await setMakeCurrentAddressRich(true)
		const canonical = await getRichModeState()
		await migrateRichMode()
		assert.deepEqual(await getRichModeState(), canonical)
		assert.equal(Object.hasOwn(storageState, 'richTokens'), false)
		assert.equal(Object.hasOwn(storageState, 'makeCurrentAddressRich'), false)
	})

	test('migration resets corrupt canonical funding state without reviving obsolete replicas', async () => {
		const storageState = installBrowserMock()
		const { getRichModeState, migrateRichMode } = await loadModules()
		storageState.richModeState = { corrupt: true }
		storageState.makeCurrentAddressRich = true
		await withSilencedConsole(async () => await migrateRichMode())
		const state = await getRichModeState()
		assert.equal(state.makeCurrentAddressRich, false)
		assert.deepEqual(state.accountBalances, [])
		assert.deepEqual(state.tokenLayouts, [])
		assert.equal(typeof storageState.richModeState, 'object')
		assert.equal(Object.hasOwn(storageState, 'makeCurrentAddressRich'), false)
	})

	test('drops a token balance whose layout is missing even when the layouts are unchanged', async () => {
		const storageState = installBrowserMock()
		const { getRichModeState, requestMakeMeRichList, updateAddressBookAndReconcileRichMode, updateRichAccountBalances, setMakeCurrentAddressRich, changeSimulationMode } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.userAddressBookEntriesV3 = [{ type: 'ERC20', address: addressString(tokenAddress), name: 'USD Coin', symbol: 'USDC', decimals: '0x6', entrySource: 'User', chainId: '0x1' }]
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: richAccountAddress })
		await setMakeCurrentAddressRich(true)
		await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 1n, tokenBalances: [{ tokenAddress, tokenId: undefined, amount: 5n }] }])
		assert.deepEqual((await getRichModeState()).tokenLayouts, [])

		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
			name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
		})
		Object.defineProperty(ethereum, 'getCode', { value: async () => new Uint8Array() })
		const presented = await withSilencedConsole(async () => await requestMakeMeRichList(ethereum, undefined))
		assert.deepEqual(presented.richAccountBalances?.find((profile) => profile.address === richAccountAddress)?.tokenBalances, [])
		assert.equal(presented.richTokenOptions?.find((option) => option.tokenAddress === tokenAddress)?.enabled, false)

		assert.equal(await updateAddressBookAndReconcileRichMode((entries) => entries), true)
		assert.deepEqual((await getRichModeState()).accountBalances[0]?.tokenBalances, [])
	})

	test('fresh and cached home data build the same rich-mode presentation from the same state', async () => {
		const storageState = installBrowserMock()
		const { getCachedRichData, getSettings, requestMakeMeRichList, updateRichAccountBalances, updateRichTokens, setMakeCurrentAddressRich, setFixedMakeMeRichList, changeSimulationMode } = await loadModules()
		const fundedToken = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		const unfundedToken = 0x6b175474e89094c44da98b954eedeac495271d0fn
		const fixedAddress = 0x2222222222222222222222222222222222222222n
		storageState.userAddressBookEntriesV3 = [
			{ type: 'ERC20', address: addressString(fundedToken), name: 'USD Coin', symbol: 'USDC', decimals: '0x6', entrySource: 'User', chainId: '0x1' },
			{ type: 'ERC20', address: addressString(unfundedToken), name: 'Dai', symbol: 'DAI', decimals: '0x12', entrySource: 'User', chainId: '0x1' },
		]
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: richAccountAddress })
		await setMakeCurrentAddressRich(true)
		await setFixedMakeMeRichList([{ address: fixedAddress, makingRich: true, type: 'UserAdded' }])
		await updateRichTokens(() => [{ chainId: 1n, tokenAddress: fundedToken, tokenType: 'ERC20', tokenId: undefined, name: 'USD Coin', symbol: 'USDC', decimals: 6n, amount: 1n, balanceSlot: 9n, erc1155StorageOrder: undefined }])
		await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 7n, tokenBalances: [{ tokenAddress: fundedToken, tokenId: undefined, amount: 5n }, { tokenAddress: unfundedToken, tokenId: undefined, amount: 6n }] }])

		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
			name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
		})
		Object.defineProperty(ethereum, 'getCode', { value: async () => new Uint8Array() })
		const presentation = ({ makeCurrentAddressRich, richNativeAmount, richAccountBalances, richTokenOptions }: Awaited<ReturnType<typeof getCachedRichData>>) => ({ makeCurrentAddressRich, richNativeAmount, richAccountBalances, richTokenOptions })
		const fresh = presentation(await withSilencedConsole(async () => await requestMakeMeRichList(ethereum, undefined)))
		const cached = presentation(await getCachedRichData(await getSettings()))
		assert.deepEqual(fresh, cached)
		assert.deepEqual(cached.richAccountBalances.map((profile) => profile.address).sort(), [richAccountAddress, fixedAddress].sort())
		assert.deepEqual(cached.richAccountBalances.find((profile) => profile.address === richAccountAddress)?.tokenBalances, [{ tokenAddress: fundedToken, tokenId: undefined, amount: 5n }])
		assert.deepEqual(cached.richTokenOptions.map((option) => [option.symbol, option.enabled]), [['USDC', true], ['DAI', false]])
	})

	test('plain address-book writes leave rich-mode state untouched', async () => {
		const writtenKeys: string[][] = []
		installBrowserMock({ onStorageSet: (items) => { writtenKeys.push(Object.keys(items)) } })
		const { updateUserAddressBookEntries, updateRichTokens } = await loadModules()
		await updateRichTokens(() => [])
		writtenKeys.length = 0
		await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Contact', address: richAccountAddress, entrySource: 'User', useAsActiveAddress: false }])
		assert.deepEqual(writtenKeys, [['userAddressBookEntriesV3']])
	})

	test('falls back per address and preserves the underlying error message', async () => {
		const storageState = installBrowserMock()
		const { requestMakeMeRichList, setFixedMakeMeRichList, setMakeCurrentAddressRich, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()
		const failingAddress = 0x1000000000000000000000000000000000000001n

		await setFixedMakeMeRichList([
			{ address: ETHEREUM_LOGS_LOGGER_ADDRESS, makingRich: true, type: 'UserAdded' },
			{ address: failingAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		await setMakeCurrentAddressRich(true)

		const ethereumClientService = {
			getRpcEntry: () => undefined,
			getCode: async (address: bigint) => {
				if (address === failingAddress) throw new Error('boom')
				return new Uint8Array()
			},
			getChainId: () => 1n,
		}

		const reply = await withSilencedConsole(async () => await requestMakeMeRichList(ethereumClientService, undefined))
		assert.equal(reply.method, 'popup_requestMakeMeRichData')
		assert.equal(reply.makeCurrentAddressRich, true)
		assert.equal(reply.richList.length, 2)
		assert.equal(reply.richList[0]?.addressBookEntry.address, ETHEREUM_LOGS_LOGGER_ADDRESS)
		assert.equal(reply.richList[1]?.addressBookEntry.type, 'contact')
		assert.equal(reply.richList[1]?.addressBookEntry.name, checksummedAddress(failingAddress))
		assert.equal(reply.richList[1]?.makingRich, false)
		assert.equal(reply.richList[1]?.type, 'PreviousActiveAddress')
		assert.equal((await getLatestUnexpectedError())?.data.message, `Failed to identify rich list address ${ checksummedAddress(failingAddress) }: boom`)
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		assert.equal(diagnostics[0]?.cause, 'boom')
		assert.equal(diagnostics[0]?.details?.includes(checksummedAddress(failingAddress)), true)
		assert.equal(typeof storageState.latestUnexpectedError, 'object')
	})

	test('projects corrupt legacy rich-list storage as empty without writing during reads', async () => {
		const storageState = installBrowserMock()
		const { getFixedAddressRichList } = await loadModules()
		storageState.fixedAddressRichList = [{ address: null, makingRich: true, type: 'UserAdded' }]

		const richList = await withSilencedConsole(async () => await getFixedAddressRichList())
		assert.deepEqual(richList, [])
		assert.equal(Object.hasOwn(storageState, 'richModeState'), false)
	})

	test('projects corrupt legacy current-address funding as disabled without writing during reads', async () => {
		const storageState = installBrowserMock()
		const { requestMakeMeRichList } = await loadModules()
		storageState.makeCurrentAddressRich = null

		const reply = await withSilencedConsole(async () => await requestMakeMeRichList({}, undefined))

		assert.equal(reply.method, 'popup_requestMakeMeRichData')
		assert.equal(reply.makeCurrentAddressRich, false)
		assert.equal(Object.hasOwn(storageState, 'richModeState'), false)
	})

	test('reports unexpected rich-token configuration failures before returning a user-facing error', async () => {
		const storageState = installBrowserMock()
		const { modifyRichToken, getLatestUnexpectedError, getUserAddressBookEntriesForChainId } = await loadModules()
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC20',
			name: 'USD Coin',
			address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
			symbol: 'USDC',
			decimals: '0x6',
			entrySource: 'User',
			chainId: '0x1',
		}]
		assert.equal((await getUserAddressBookEntriesForChainId(1n))[0]?.type, 'ERC20')
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async () => {
				throw new Error('probe exploded')
			},
		})

		const reply = await withSilencedConsole(async () => await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n },
		}))

		assert.equal(reply.result.success, false)
		assert.equal((await getLatestUnexpectedError())?.data.code, 'rich_token_config_failed')
		assert.ok((await getLatestUnexpectedError())?.data.message.includes('probe exploded'))
	})

	test('replies with an explicit outcome and reports the error when the refresh after a saved token change rejects', async () => {
		installBrowserMock()
		const { refreshSimulationAfterRichTokenChange, getLatestUnexpectedError } = await loadModules()
		assert.equal(await refreshSimulationAfterRichTokenChange(async () => ({ status: 'observed', available: true })), 'Refreshed')
		assert.equal(await refreshSimulationAfterRichTokenChange(async () => ({ status: 'observed', available: false })), 'Unavailable')
		assert.equal(await getLatestUnexpectedError(), undefined)

		const outcome = await withSilencedConsole(async () => await refreshSimulationAfterRichTokenChange(async () => { throw new Error('refresh exploded') }))
		assert.equal(outcome, 'Unavailable')
		const reported = await getLatestUnexpectedError()
		assert.equal(reported?.data.code, 'rich_token_simulation_refresh_failed')
		assert.equal(reported?.data.message, 'Token funding was saved, but refreshing the simulation failed: refresh exploded')
	})

	test('does not report a refresh as completed when it was superseded by a replacement that then fails', async () => {
		installBrowserMock()
		const { refreshSimulationAfterRichTokenChange } = await loadModules()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
			name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
		})
		const tokenPriceService = new TokenPriceService(ethereum, 60_000)
		let releaseActiveRefresh = () => undefined
		const activeRefreshGate = new Promise<void>((resolve) => { releaseActiveRefresh = resolve })
		const refresh = createPopupSimulationRefresher<{ ethereum: EthereumClientService, tokenPriceService: TokenPriceService, revision: string }>(async ({ revision }) => {
			if (revision === 'active') {
				await activeRefreshGate
				return true
			}
			throw new Error('replacement refresh failed')
		})
		const activeRefresh = refresh({ ethereum, tokenPriceService, revision: 'active' })
		await Promise.resolve()
		await Promise.resolve()
		const tokenChangeOutcome = refreshSimulationAfterRichTokenChange(async () => await refresh({ ethereum, tokenPriceService, revision: 'token change' }))
		const replacementRefresh = refresh({ ethereum, tokenPriceService, revision: 'replacement' })
		assert.equal(await tokenChangeOutcome, 'Superseded')
		releaseActiveRefresh()
		assert.deepEqual(await activeRefresh, { status: 'observed', available: true })
		await assert.rejects(replacementRefresh, /replacement refresh failed/u)
	})

	test('one eligibility rule: ERC-20 entries with supported decimals and watched ERC-1155 token IDs on the chain', async () => {
		const storageState = installBrowserMock()
		const { getRichTokenEligibilityFromAddressBook } = await loadModules()
		const { getRichTokenEligibility } = await import('../../app/ts/utils/richTokens.js')
		const erc20Address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		const wideDecimalsAddress = 0x6666666666666666666666666666666666666666n
		const erc1155Address = 0x4444444444444444444444444444444444444444n
		storageState.userAddressBookEntriesV3 = [
			{ type: 'ERC20', address: addressString(erc20Address), name: 'USD Coin', symbol: 'USDC', decimals: '0x6', entrySource: 'User', chainId: '0x1' },
			{ type: 'ERC1155', address: addressString(erc1155Address), name: 'Game Items', symbol: 'ITEM', entrySource: 'User', chainId: '0x1', watchedTokenIds: ['0x7'] },
		]
		const symbolOf = async (chainId: bigint, tokenAddress: bigint, tokenId: bigint | undefined) => {
			const eligibility = await getRichTokenEligibilityFromAddressBook(chainId, { tokenAddress, tokenId })
			return eligibility.eligible ? eligibility.metadataEntry.symbol : eligibility.reason
		}
		assert.equal(await symbolOf(1n, erc20Address, undefined), 'USDC')
		// Stored entries with such decimals are repaired into contracts on read, so the decimals rule is checked on the pure function.
		assert.deepEqual(getRichTokenEligibility([{ type: 'ERC20', address: wideDecimalsAddress, name: 'Wide', symbol: 'WIDE', decimals: 256n, entrySource: 'User', chainId: 1n }], 1n, { tokenAddress: wideDecimalsAddress, tokenId: undefined }), { eligible: false, reason: 'UnsupportedDecimals' })
		assert.equal(await symbolOf(10n, erc20Address, undefined), 'NotInAddressBook')
		assert.equal(await symbolOf(1n, erc20Address, 7n), 'NotInAddressBook')
		assert.equal(await symbolOf(1n, erc1155Address, 7n), 'ITEM')
		assert.equal(await symbolOf(1n, erc1155Address, 8n), 'NotInAddressBook')
		assert.equal(await symbolOf(1n, erc1155Address, undefined), 'NotInAddressBook')
	})

	test('discovers token storage only for an eligible token without a stored layout', async () => {
		const storageState = installBrowserMock()
		const { discoverRichTokenStorage, updateRichTokens } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.userAddressBookEntriesV3 = [{ type: 'ERC20', address: addressString(tokenAddress), name: 'USD Coin', symbol: 'USDC', decimals: '0x6', entrySource: 'User', chainId: '0x1' }]
		let probeCount = 0
		const ethereum = { ethSimulateV1: async () => { probeCount += 1; return [] } }
		const add = { action: 'Add' as const, address: richAccountAddress, tokenAddress }
		assert.equal(await discoverRichTokenStorage(ethereum, undefined, 1n, { ...add, action: 'Remove' }), undefined)
		assert.equal(await discoverRichTokenStorage(ethereum, undefined, 1n, { ...add, tokenAddress: 0x5555555555555555555555555555555555555555n }), undefined)
		assert.equal(probeCount, 0)
		assert.deepEqual(await discoverRichTokenStorage(ethereum, undefined, 1n, add), { balanceSlot: undefined, erc1155StorageOrder: undefined })
		assert.equal(probeCount, 1)
		await updateRichTokens(() => [{ chainId: 1n, tokenAddress, tokenType: 'ERC20', tokenId: undefined, name: 'USD Coin', symbol: 'USDC', decimals: 6n, amount: 1n, balanceSlot: 9n, erc1155StorageOrder: undefined }])
		assert.equal(await discoverRichTokenStorage(ethereum, undefined, 1n, add), undefined)
		assert.equal(probeCount, 1)
	})

	test('requires rich tokens to come from the active-chain address book', async () => {
		installBrowserMock()
		const { modifyRichToken, getLatestUnexpectedError, getRichTokens, updateRichTokens } = await loadModules()
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n,
			tokenType: 'ERC20' as const,
			tokenId: undefined,
			name: 'Stale USD Coin',
			symbol: 'USDC',
			decimals: 6n,
			amount: 1n,
			balanceSlot: 9n,
			erc1155StorageOrder: undefined,
		}])
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		let probeCount = 0
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async () => {
				probeCount += 1
				return []
			},
		})

		const reply = await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n },
		})

		assert.deepEqual(reply, {
			method: 'popup_modifyRichToken',
			result: { success: false, error: 'Choose an ERC-20 token or watched ERC-1155 token ID from the address book for the active chain.' },
		})
		assert.equal(probeCount, 0)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getRichTokens(), [])
	})

	test('rejects ERC-20 entries invalidated by startup decimal recovery before storage discovery', async () => {
		const storageState = installBrowserMock()
		const { modifyRichToken } = await loadModules()
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC20',
			name: 'Hostile token',
			address: '0x3333333333333333333333333333333333333333',
			symbol: 'BAD',
			decimals: '0x100',
			entrySource: 'User',
			chainId: '0x1',
		}]
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		let probeCount = 0
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async () => {
				probeCount += 1
				return []
			},
		})

		const reply = await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress: 0x3333333333333333333333333333333333333333n },
		})

		assert.deepEqual(reply, {
			method: 'popup_modifyRichToken',
			result: { success: false, error: 'Choose an ERC-20 token or watched ERC-1155 token ID from the address book for the active chain.' },
		})
		assert.equal(probeCount, 0)
	})

	test('uses exact-chain address-book metadata over an AllChains duplicate', async () => {
		const storageState = installBrowserMock()
		const { modifyRichToken, requestMakeMeRichList } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.userAddressBookEntriesV3 = [
			{
				type: 'ERC20',
				name: 'Global token',
				address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
				symbol: 'GLOBAL',
				decimals: '0x12',
				entrySource: 'User',
				chainId: 'AllChains',
			},
			{
				type: 'ERC20',
				name: 'USD Coin',
				address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
				symbol: 'USDC',
				decimals: '0x6',
				entrySource: 'User',
				chainId: '0x1',
			},
		]
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async (blocks: readonly unknown[]) => blocks.length === 1
				? [successfulBalanceCall(0xfedcba987654321n)]
				: blocks.map((_block, index) => successfulBalanceCall(index === 9 ? 0x123456789abcdefn : 0n)),
		})

		const richData = await requestMakeMeRichList(ethereum, undefined)
		assert.equal(richData.richTokenOptions[0]?.symbol, 'USDC')
		assert.equal(richData.richTokenOptions[0]?.decimals, 6n)
		const reply = await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress },
		})

		assert.equal(reply.result.success, true)
		if (reply.result.success === false) throw new Error(reply.result.error)
		assert.equal(reply.result.richToken?.name, 'USD Coin')
		assert.equal(reply.result.richToken?.symbol, 'USDC')
		assert.equal(reply.result.richToken?.decimals, 6n)
		assert.equal(reply.result.richToken?.balanceSlot, 9n)
	})

	test('configures a watched ERC-1155 token ID through nested balance discovery', async () => {
		const storageState = installBrowserMock()
		const { modifyRichToken, requestMakeMeRichList } = await loadModules()
		const tokenAddress = 0x4444444444444444444444444444444444444444n
		storageState.userAddressBookEntriesV3 = [
			{
				type: 'ERC1155',
				name: 'Exact Game Items',
				address: '0x4444444444444444444444444444444444444444',
				symbol: 'ITEM',
				decimals: undefined,
				entrySource: 'User',
				chainId: '0x1',
				watchedTokenIds: ['0x7'],
			},
			{
				type: 'ERC1155',
				name: 'Global Game Items',
				address: '0x4444444444444444444444444444444444444444',
				symbol: 'GLOBAL',
				decimals: undefined,
				entrySource: 'User',
				chainId: 'AllChains',
				watchedTokenIds: ['0x2a'],
			},
		]
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async (blocks: readonly unknown[]) => blocks.length === 1
				? [successfulBalanceCall(0xfedcba987654321n)]
				: blocks.map((_block, index) => successfulBalanceCall(index === 6 ? 0x123456789abcdefn : 0n)),
		})

		const richData = await requestMakeMeRichList(ethereum, undefined)
		assert.equal(richData.richTokenOptions.some((option) => option.tokenType === 'ERC1155' && option.tokenId === 42n && option.name === 'Exact Game Items'), true)
		const reply = await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress, tokenId: 42n },
		})

		assert.equal(reply.result.success, true)
		if (reply.result.success === false) throw new Error(reply.result.error)
		assert.equal(reply.result.richToken?.tokenType, 'ERC1155')
		assert.equal(reply.result.richToken?.tokenId, 42n)
		assert.equal(reply.result.richToken?.name, 'Exact Game Items')
		assert.equal(reply.result.richToken?.balanceSlot, 3n)
		assert.equal(reply.result.richToken?.erc1155StorageOrder, 'TokenIdThenOwner')
	})

	test('verifies and reuses a configured ERC-1155 contract layout for another watched ID', async () => {
		const storageState = installBrowserMock()
		const { getRichTokens, modifyRichToken, updateRichTokens } = await loadModules()
		const tokenAddress = 0x4444444444444444444444444444444444444444n
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC1155',
			name: 'Game Items',
			address: '0x4444444444444444444444444444444444444444',
			symbol: 'ITEM',
			decimals: undefined,
			entrySource: 'User',
			chainId: '0x1',
			watchedTokenIds: ['0x7', '0x2a'],
		}]
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC1155',
			tokenId: 7n,
			name: 'Game Items',
			symbol: 'ITEM',
			decimals: 0n,
			amount: 1_000_000n,
			balanceSlot: 3n,
			erc1155StorageOrder: 'TokenIdThenOwner',
		}])
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		let simulationCalls = 0
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async (blocks: readonly unknown[]) => {
				simulationCalls += 1
				assert.equal(blocks.length, 1)
				return [successfulBalanceCall(0xfedcba987654321n)]
			},
		})

		const reply = await modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress, tokenId: 42n },
		})

		assert.equal(reply.result.success, true)
		if (reply.result.success === false) throw new Error(reply.result.error)
		assert.equal(simulationCalls, 1)
		assert.equal(reply.result.richToken?.balanceSlot, 3n)
		assert.equal(reply.result.richToken?.erc1155StorageOrder, 'TokenIdThenOwner')
		assert.deepEqual((await getRichTokens()).map((token) => token.tokenId), [7n, 42n])
	})

	test('reconciles removed ERC-1155 token IDs on address-book changes before simulation reads', async () => {
		const storageState = installBrowserMock()
		const { changeSimulationMode, getCurrentSimulationInput, getRichTokens, modifyMakeMeRich, updateRichTokens, updateAddressBookAndReconcileRichMode } = await loadModules()
		const activeAddress = 0x8000000000000000000000000000000000000008n
		const tokenAddress = 0x4444444444444444444444444444444444444444n
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC1155',
			name: 'Game Items',
			address: '0x4444444444444444444444444444444444444444',
			symbol: 'ITEM',
			decimals: undefined,
			entrySource: 'User',
			chainId: '0x1',
			watchedTokenIds: ['0x7'],
		}]
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC1155',
			tokenId: 42n,
			name: 'Game Items',
			symbol: 'ITEM',
			decimals: 0n,
			amount: 100n,
			balanceSlot: 0n,
			erc1155StorageOrder: 'OwnerThenTokenId',
		}])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })

		await updateAddressBookAndReconcileRichMode((entries) => entries)
		const simulationInput = await getCurrentSimulationInput()

		assert.deepEqual(await getRichTokens(), [])
		assert.equal(simulationInput[0]?.stateOverrides[addressString(tokenAddress)], undefined)
	})

	for (const edit of ['removal', 'watched-ID change', 'token-type change', 'metadata-only edit', 'no-op edit'] as const) {
		test(`address-book ${ edit } refreshes simulation only when funding changes`, async () => {
			let visibilityProbeCount = 0
			const storageState = installBrowserMock({ onRuntimeSendMessage: (message) => {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') visibilityProbeCount += 1
			} })
			const { addOrModifyAddressBookEntry, removeAddressBookEntry, updateRichTokens, updateRichAccountBalances, setMakeCurrentAddressRich, getRichModeState } = await loadModules()
			const entry: Erc1155Entry = {
				type: 'ERC1155', name: 'Game Items', address: 0x4444444444444444444444444444444444444444n,
				symbol: 'ITEM', entrySource: 'User', chainId: 1n, watchedTokenIds: [42n],
			}
			storageState.userAddressBookEntriesV3 = [serialize(AddressBookEntry, entry)]
			storageState.simulationMode = true
			storageState.independentActiveSimulationAddress = addressString(richAccountAddress)
			await updateRichTokens(() => [{
				chainId: 1n, tokenAddress: entry.address, tokenType: 'ERC1155', tokenId: 42n,
				name: entry.name, symbol: entry.symbol, decimals: 0n, amount: 100n,
				balanceSlot: 3n, erc1155StorageOrder: 'TokenIdThenOwner',
			}])
			await updateRichAccountBalances(() => [{
				chainId: 1n, address: richAccountAddress, nativeAmount: 1n,
				tokenBalances: [{ tokenAddress: entry.address, tokenId: 42n, amount: 100n }],
			}])
			await setMakeCurrentAddressRich(true)
			const requestHandler = new MockRequestHandler()
			const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
				name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
			})
			const services = createTestSimulationServicesOwner({ ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) })
			if (edit === 'removal') {
				await removeAddressBookEntry(services, new Map(), {
					method: 'popup_removeAddressBookEntry',
					data: { address: entry.address, addressBookCategory: 'ERC1155 Tokens', chainId: 1n },
				})
			} else {
				const updatedEntry: AddressBookEntry = edit === 'token-type change'
					? { type: 'contract', name: entry.name, address: entry.address, chainId: 1n, entrySource: 'User' }
					: edit === 'watched-ID change'
						? { ...entry, watchedTokenIds: [] }
						: edit === 'metadata-only edit'
							? { ...entry, name: 'Renamed Game Items', symbol: 'RENAMED' }
							: entry
				assert.deepEqual(await addOrModifyAddressBookEntry(services, new Map(), {
					method: 'popup_addOrModifyAddressBookEntry', data: updatedEntry,
				}), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
			}
			const fundingChanged = edit === 'removal' || edit === 'watched-ID change' || edit === 'token-type change'
			assert.equal(visibilityProbeCount, fundingChanged ? 1 : 0)
			assert.equal((await getRichModeState()).accountBalances[0]?.tokenBalances.length, fundingChanged ? 0 : 1)
		})
	}

	for (const approval of ['replaces the funded token entry', 'adds an unrelated token'] as const) {
		test(`a watch-asset approval that ${ approval } refreshes simulation only when funding changes`, async () => {
			let visibilityProbeCount = 0
			const storageState = installBrowserMock({ onRuntimeSendMessage: (message) => {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') visibilityProbeCount += 1
			} })
			const { replaceAddressBookEntryWithAsset, updateRichTokens, updateRichAccountBalances, setMakeCurrentAddressRich, getRichModeState, watchAssetResolutionDependencies } = await loadModules()
			const fundedEntry: Erc1155Entry = {
				type: 'ERC1155', name: 'Game Items', address: 0x4444444444444444444444444444444444444444n,
				symbol: 'ITEM', entrySource: 'User', chainId: 1n, watchedTokenIds: [42n],
			}
			storageState.userAddressBookEntriesV3 = [serialize(AddressBookEntry, fundedEntry)]
			storageState.simulationMode = true
			storageState.independentActiveSimulationAddress = addressString(richAccountAddress)
			await updateRichTokens(() => [{
				chainId: 1n, tokenAddress: fundedEntry.address, tokenType: 'ERC1155', tokenId: 42n,
				name: fundedEntry.name, symbol: fundedEntry.symbol, decimals: 0n, amount: 100n,
				balanceSlot: 3n, erc1155StorageOrder: 'TokenIdThenOwner',
			}])
			await updateRichAccountBalances(() => [{ chainId: 1n, address: richAccountAddress, nativeAmount: 1n, tokenBalances: [{ tokenAddress: fundedEntry.address, tokenId: 42n, amount: 100n }] }])
			await setMakeCurrentAddressRich(true)
			const requestHandler = new MockRequestHandler()
			const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
				name: 'Ethereum', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true,
			})
			const services = createTestSimulationServicesOwner({ ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) })
			const approvedAddress = approval === 'replaces the funded token entry' ? fundedEntry.address : 0x5555555555555555555555555555555555555555n
			const dependencies = watchAssetResolutionDependencies(new Map(), services)
			await dependencies.updateAddressBook((entries) => replaceAddressBookEntryWithAsset(entries, { type: 'ERC721', name: 'Approved NFT', address: approvedAddress, symbol: 'NFT', entrySource: 'User', chainId: 1n }))
			const fundingChanged = approval === 'replaces the funded token entry'
			assert.equal(visibilityProbeCount, fundingChanged ? 1 : 0)
			assert.equal((await getRichModeState()).accountBalances[0]?.tokenBalances.length, fundingChanged ? 0 : 1)
		})
	}

	test('address-book removal wins against an in-flight token storage scan', async () => {
		const storageState = installBrowserMock()
		const { modifyRichToken, removeAddressBookEntry, getRichTokens } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC20',
			name: 'USD Coin',
			address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
			symbol: 'USDC',
			decimals: '0x6',
			entrySource: 'User',
			chainId: '0x1',
		}]
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)
		let signalProbeStarted = () => undefined
		const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve })
		let releaseProbe = () => undefined
		const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
		Object.defineProperty(ethereum, 'ethSimulateV1', {
			value: async (blocks: readonly unknown[]) => {
				if (blocks.length === 1) return [successfulBalanceCall(0xfedcba987654321n)]
				signalProbeStarted()
				await probeGate
				return blocks.map((_block, index) => successfulBalanceCall(index === 9 ? 0x123456789abcdefn : 0n))
			},
		})
		const addPromise = modifyRichToken(ethereum, undefined, {
			method: 'popup_modifyRichToken',
			data: { action: 'Add', address: richAccountAddress, tokenAddress },
		})
		await probeStarted
		const removePromise = removeAddressBookEntry(
			createTestSimulationServicesOwner({ ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) }),
			new Map(),
			{
				method: 'popup_removeAddressBookEntry',
				data: { address: tokenAddress, addressBookCategory: 'ERC20 Tokens', chainId: 1n },
			},
		)
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				removePromise,
				new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Address-book removal waited for the RPC scan')), 2000) }),
			])
		} finally {
			clearTimeout(timeout)
			releaseProbe()
		}
		assert.equal((await addPromise).result.success, false)

		assert.deepEqual(await getRichTokens(), [])
	})

	test('removing an AllChains duplicate preserves exact-chain token funding', async () => {
		const storageState = installBrowserMock()
		const { getRichTokens, removeAddressBookEntry, updateRichTokens } = await loadModules()
		const tokenAddress = 0x3333333333333333333333333333333333333333n
		storageState.userAddressBookEntriesV3 = [
			{
				type: 'ERC20',
				name: 'Global token',
				address: '0x3333333333333333333333333333333333333333',
				symbol: 'GLOBAL',
				decimals: '0x12',
				entrySource: 'User',
				chainId: 'AllChains',
			},
			{
				type: 'ERC20',
				name: 'Exact token',
				address: '0x3333333333333333333333333333333333333333',
				symbol: 'EXACT',
				decimals: '0x12',
				entrySource: 'User',
				chainId: '0x1',
			},
		]
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC20' as const,
			tokenId: undefined,
			name: 'Exact token',
			symbol: 'EXACT',
			decimals: 18n,
			amount: 100n,
			balanceSlot: 2n,
			erc1155StorageOrder: undefined,
		}])
		const requestHandler = new MockRequestHandler()
		const ethereum = new EthereumClientService(
			requestHandler,
			async () => undefined,
			async () => undefined,
			{
				name: 'Ethereum',
				chainId: 1n,
				httpsRpc: requestHandler.rpcUrl,
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		)

		await removeAddressBookEntry(
			createTestSimulationServicesOwner({ ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) }),
			new Map(),
			{
				method: 'popup_removeAddressBookEntry',
				data: { address: tokenAddress, addressBookCategory: 'ERC20 Tokens', chainId: 'AllChains' },
			},
		)

		assert.equal((await getRichTokens()).length, 1)
	})

})

describe('startup storage recovery', () => {
	test('repairs only legacy ERC20 entries with out-of-range decimals', async () => {
		const storageState = installBrowserMock()
		const { getUserAddressBookEntries } = await loadModules()
		storageState.userAddressBookEntriesV3 = [
			{ type: 'contact', name: 'Preserved contact', address: '0x0000000000000000000000000000000000000001', entrySource: 'User' },
			{ type: 'ERC20', name: 'Invalid token', address: '0x0000000000000000000000000000000000000002', symbol: 'BAD', decimals: '0x100', entrySource: 'User', chainId: '0x1' },
		]

		const entries = await getUserAddressBookEntries()

		assert.equal(entries.length, 2)
		assert.deepEqual(entries[0], { type: 'contact', name: 'Preserved contact', address: 1n, entrySource: 'User' })
		assert.deepEqual(entries[1], { type: 'contract', name: 'Invalid token', address: 2n, entrySource: 'User', chainId: 1n })
		assert.deepEqual(storageState.userAddressBookEntriesV3, [
			{ type: 'contact', name: 'Preserved contact', address: '0x0000000000000000000000000000000000000001', entrySource: 'User' },
			{ type: 'contract', name: 'Invalid token', address: '0x0000000000000000000000000000000000000002', entrySource: 'User', chainId: '0x1' },
		])
	})

	test('recovers active addresses from corrupt user address book storage', async () => {
		const storageState = installBrowserMock()
		const { requestActiveAddresses, defaultActiveAddresses, getUserAddressBookEntries } = await loadModules()
		storageState.userAddressBookEntriesV3 = null

		const reply = await withSilencedConsole(async () => await requestActiveAddresses())

		assert.equal(reply.method, 'popup_requestActiveAddresses')
		assert.deepEqual(reply.activeAddresses, defaultActiveAddresses)
		assert.ok(Array.isArray(storageState.userAddressBookEntriesV3))
		assert.deepEqual(await getUserAddressBookEntries(), defaultActiveAddresses)
	})

	test('recovers latest unexpected error from corrupt storage by clearing it', async () => {
		const storageState = installBrowserMock()
		const { requestLatestUnexpectedError } = await loadModules()
		storageState.latestUnexpectedError = null

		const reply = await withSilencedConsole(async () => await requestLatestUnexpectedError())

		assert.equal(reply.method, 'popup_requestLatestUnexpectedError')
		assert.equal(reply.latestUnexpectedError, undefined)
		assert.equal(storageState.latestUnexpectedError, undefined)
	})

	test('reads a corrupt simulationMode as simulation mode without writing it', async () => {
		const storageState = installBrowserMock()
		const { requestSimulationMode } = await loadModules()
		storageState.simulationMode = 'invalid'

		const reply = await withSilencedConsole(async () => await requestSimulationMode())

		assert.equal(reply.method, 'popup_requestSimulationMode')
		assert.equal(reply.simulationMode, true)
		// Settings reads never write simulationMode (see getStartupStorageValueOrDefault); the next mode change replaces the corrupt value.
		assert.equal(storageState.simulationMode, 'invalid')
	})

	test('recovers corrupt websiteAccess without resetting valid settings keys', async () => {
		const storageState = installBrowserMock()
		const { getSettings } = await loadModules()
		storageState.websiteAccess = [null]
		storageState.simulationMode = false

		const settings = await withSilencedConsole(async () => await getSettings())

		assert.deepEqual(settings.websiteAccess, [])
		assert.equal(settings.simulationMode, false)
		assert.deepEqual(storageState.websiteAccess, [])
		assert.equal(storageState.simulationMode, false)
	})

	test('sanitizes remote website access icons in returned settings without mutating storage', async () => {
		const storageState = installBrowserMock()
		const { getSettings, getWebsiteAccess } = await loadModules()
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]

		const settings = await withSilencedConsole(async () => await getSettings())
		const websiteAccess = await withSilencedConsole(async () => await getWebsiteAccess())

		assert.equal(settings.websiteAccess[0]?.website.icon, undefined)
		assert.equal(settings.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
		assert.equal(websiteAccess[0]?.website.icon, undefined)
		assert.equal(websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.icon, 'https://remote.example/favicon.png')
		assert.equal(storageState.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})

	test('recovers corrupt openedPageV2 without resetting valid settings keys', async () => {
		const storageState = installBrowserMock()
		const { getSettings } = await loadModules()
		storageState.openedPageV2 = null
		storageState.useSignersAddressAsActiveAddress = true

		const settings = await withSilencedConsole(async () => await getSettings())

		assert.deepEqual(settings.openedPage, { page: 'Home' })
		assert.equal(settings.useSignersAddressAsActiveAddress, true)
		assert.deepEqual(storageState.openedPageV2, { page: 'Home' })
		assert.equal(storageState.useSignersAddressAsActiveAddress, true)
	})
})
