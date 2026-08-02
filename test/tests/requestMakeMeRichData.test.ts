import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, bigintToUint8Array, checksummedAddress } from '../../app/ts/utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import type { ResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'

const richAccountAddress = 0x1111111111111111111111111111111111111111n

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock(options: { onRuntimeSendMessage?: () => void, onStorageSet?: (items: Record<string, unknown>) => void | Promise<void> } = {}) {
	const storageState: Record<string, unknown> = {}
	defineGlobal('browser', {
		runtime: {
			lastError: null,
			async sendMessage() {
				options.onRuntimeSendMessage?.()
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
			if ('fixedAddressRichList' in items) fixedRichListWriteCount += 1
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
		assert.deepEqual(storageState.fixedAddressRichList, [{ address: checksummedAddress(address), makingRich: true, type: 'UserAdded' }])
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

	test('migrates global token balances once without adding them to later rich accounts', async () => {
		installBrowserMock()
		const { ensureRichAccountBalances, updateRichTokens } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'USD Coin',
			symbol: 'USDC',
			decimals: 6n,
			amount: 1_000_000n,
			balanceSlot: 9n,
			erc1155StorageOrder: undefined,
		}])

		const migrated = await ensureRichAccountBalances(1n, [richAccountAddress])
		assert.equal(migrated.find((profile) => profile.address === richAccountAddress)?.tokenBalances.length, 1)
		const laterAddress = 0x2222222222222222222222222222222222222222n
		const withLaterAccount = await ensureRichAccountBalances(1n, [laterAddress])
		assert.deepEqual(withLaterAccount.find((profile) => profile.address === laterAddress)?.tokenBalances, [])
	})

	test('migrates legacy token balances for every configured chain on the first account migration', async () => {
		installBrowserMock()
		const { ensureRichAccountBalances, updateRichTokens } = await loadModules()
		const mainnetTokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		const optimismTokenAddress = 0x4200000000000000000000000000000000000042n
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress: mainnetTokenAddress,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'Mainnet Token',
			symbol: 'MAIN',
			decimals: 18n,
			amount: 1_000n,
			balanceSlot: 1n,
			erc1155StorageOrder: undefined,
		}, {
			chainId: 10n,
			tokenAddress: optimismTokenAddress,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'Optimism Token',
			symbol: 'OP',
			decimals: 18n,
			amount: 2_000n,
			balanceSlot: 2n,
			erc1155StorageOrder: undefined,
		}])

		const migrated = await ensureRichAccountBalances(1n, [richAccountAddress, richAccountAddress])
		assert.equal(migrated.filter((profile) => profile.chainId === 1n && profile.address === richAccountAddress).length, 1)
		assert.equal(migrated.filter((profile) => profile.chainId === 10n && profile.address === richAccountAddress).length, 1)
		assert.deepEqual(migrated.find((profile) => profile.chainId === 1n)?.tokenBalances, [{
			tokenAddress: mainnetTokenAddress,
			tokenId: undefined,
			amount: 1_000n,
		}])
		assert.deepEqual(migrated.find((profile) => profile.chainId === 10n)?.tokenBalances, [{
			tokenAddress: optimismTokenAddress,
			tokenId: undefined,
			amount: 2_000n,
		}])

		const laterAddress = 0x2222222222222222222222222222222222222222n
		const withLaterAccount = await ensureRichAccountBalances(10n, [laterAddress])
		assert.deepEqual(withLaterAccount.find((profile) => profile.chainId === 10n && profile.address === laterAddress)?.tokenBalances, [])
	})

	test('preserves pending legacy migration when stale token layouts are reconciled first', async () => {
		const storageState = installBrowserMock()
		const { ensureRichAccountBalances, reconcileRichTokensWithAddressBook, updateRichTokens } = await loadModules()
		const supportedAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		storageState.userAddressBookEntriesV3 = [{
			type: 'ERC20',
			name: 'USD Coin',
			address: addressString(supportedAddress),
			symbol: 'USDC',
			decimals: '0x6',
			entrySource: 'User',
			chainId: '0x1',
		}]
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress: supportedAddress,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'USD Coin',
			symbol: 'USDC',
			decimals: 6n,
			amount: 1_000_000n,
			balanceSlot: 9n,
			erc1155StorageOrder: undefined,
		}, {
			chainId: 1n,
			tokenAddress: 0x3333333333333333333333333333333333333333n,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'Removed Token',
			symbol: 'OLD',
			decimals: 18n,
			amount: 1n,
			balanceSlot: 2n,
			erc1155StorageOrder: undefined,
		}])

		await reconcileRichTokensWithAddressBook()
		assert.equal(Object.hasOwn(storageState, 'richAccountBalances'), false)
		const profiles = await ensureRichAccountBalances(1n, [richAccountAddress])
		assert.deepEqual(profiles[0]?.tokenBalances.map((balance) => balance.tokenAddress), [supportedAddress])
	})

	test('serializes concurrent first-time profile creation so legacy tokens migrate once', async () => {
		let signalFirstProfileWrite = () => undefined
		const firstProfileWrite = new Promise<void>((resolve) => { signalFirstProfileWrite = resolve })
		let releaseFirstProfileWrite = () => undefined
		const firstProfileWriteGate = new Promise<void>((resolve) => { releaseFirstProfileWrite = resolve })
		let profileWriteCount = 0
		installBrowserMock({ onStorageSet: async (items) => {
			if (!Object.hasOwn(items, 'richAccountBalances')) return
			profileWriteCount += 1
			if (profileWriteCount !== 1) return
			signalFirstProfileWrite()
			await firstProfileWriteGate
		} })
		const { ensureRichAccountBalances, updateRichTokens } = await loadModules()
		const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress,
			tokenType: 'ERC20',
			tokenId: undefined,
			name: 'USD Coin',
			symbol: 'USDC',
			decimals: 6n,
			amount: 1_000_000n,
			balanceSlot: 9n,
			erc1155StorageOrder: undefined,
		}])
		const laterAddress = 0x2222222222222222222222222222222222222222n

		const firstProfilesPromise = ensureRichAccountBalances(1n, [richAccountAddress])
		await firstProfileWrite
		const secondProfilesPromise = ensureRichAccountBalances(1n, [laterAddress])
		releaseFirstProfileWrite()
		const [firstProfiles, secondProfiles] = await Promise.all([firstProfilesPromise, secondProfilesPromise])

		assert.equal(firstProfiles.find((profile) => profile.address === richAccountAddress)?.tokenBalances.length, 1)
		assert.deepEqual(secondProfiles.find((profile) => profile.address === laterAddress)?.tokenBalances, [])
	})

	test('recovers corrupt account-specific rich balances without legacy token migration', async () => {
		const storageState = installBrowserMock()
		const { ensureRichAccountBalances } = await loadModules()
		storageState.richAccountBalances = null

		const profiles = await withSilencedConsole(async () => await ensureRichAccountBalances(1n, [richAccountAddress]))

		assert.equal(profiles.length, 1)
		assert.equal(profiles[0]?.address, richAccountAddress)
		assert.deepEqual(profiles[0]?.tokenBalances, [])
		assert.equal(Array.isArray(storageState.richAccountBalances), true)
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

	test('recovers from corrupt fixed rich list storage by resetting it to an empty list', async () => {
		const storageState = installBrowserMock()
		const { getFixedAddressRichList } = await loadModules()
		storageState.fixedAddressRichList = [{ address: null, makingRich: true, type: 'UserAdded' }]

		const richList = await withSilencedConsole(async () => await getFixedAddressRichList())
		assert.deepEqual(richList, [])
		assert.deepEqual(storageState.fixedAddressRichList, [])
	})

	test('recovers from corrupt makeCurrentAddressRich storage by resetting it to false', async () => {
		const storageState = installBrowserMock()
		const { requestMakeMeRichList } = await loadModules()
		storageState.makeCurrentAddressRich = null

		const reply = await withSilencedConsole(async () => await requestMakeMeRichList({}, undefined))

		assert.equal(reply.method, 'popup_requestMakeMeRichData')
		assert.equal(reply.makeCurrentAddressRich, false)
		assert.equal(storageState.makeCurrentAddressRich, false)
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

	test('requires rich tokens to come from the active-chain address book', async () => {
		installBrowserMock()
		const { modifyRichToken, getLatestUnexpectedError, getRichTokens, updateRichTokens } = await loadModules()
		await updateRichTokens(() => [{
			chainId: 1n,
			tokenAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n,
			tokenType: 'ERC20',
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

	test('rejects ERC-20 decimals above uint8 before storage discovery', async () => {
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
			result: { success: false, error: 'ERC-20 decimals cannot exceed 255 in rich mode.' },
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

	test('reconciles removed ERC-1155 token IDs before applying simulation overrides', async () => {
		const storageState = installBrowserMock()
		const { changeSimulationMode, getCurrentSimulationInput, getRichTokens, modifyMakeMeRich, updateRichTokens } = await loadModules()
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

		const simulationInput = await getCurrentSimulationInput()

		assert.deepEqual(await getRichTokens(), [])
		assert.equal(simulationInput[0]?.stateOverrides[addressString(tokenAddress)], undefined)
	})

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
			ethereum,
			new TokenPriceService(ethereum, 60_000),
			() => undefined,
			new Map(),
			{
				method: 'popup_removeAddressBookEntry',
				data: { address: tokenAddress, addressBookCategory: 'ERC20 Tokens', chainId: 1n },
			},
		)
		releaseProbe()
		await Promise.all([addPromise, removePromise])

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
			tokenType: 'ERC20',
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
			ethereum,
			new TokenPriceService(ethereum, 60_000),
			() => undefined,
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

	test('recovers simulationMode from corrupt settings storage', async () => {
		const storageState = installBrowserMock()
		const { requestSimulationMode } = await loadModules()
		storageState.simulationMode = 'invalid'

		const reply = await withSilencedConsole(async () => await requestSimulationMode())

		assert.equal(reply.method, 'popup_requestSimulationMode')
		assert.equal(reply.simulationMode, true)
		assert.equal(storageState.simulationMode, true)
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
