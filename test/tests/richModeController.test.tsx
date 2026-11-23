import * as assert from 'node:assert'
import { test } from 'bun:test'
import { usePopupSettingsChanges } from '../../app/ts/components/hooks/usePopupSettingsChanges.js'
import { requestRichSettingsChange } from '../../app/ts/components/popupSettingsChange.js'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useRichModeTokens, type RichModeTokenController } from '../../app/ts/components/hooks/useRichModeTokens.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../app/ts/types/richMode.js'
import { installDomMock } from './domMock.js'

test('rich controller observes the funding snapshot arriving and changing without remounting', async () => {
	const dom = installDomMock()
	const chain = signal<bigint | undefined>(undefined)
	const account: AddressBookEntry = { type: 'contact', address: 1n, name: 'Funded account', entrySource: 'User' }
	let controller: RichModeTokenController | undefined
	const inputs: Parameters<typeof useRichModeTokens>[0] = {
			activeAddress: signal(account), richFundingChainId: chain, isInitialHomeDataLoaded: signal(true), isSettingsChangePending: signal(false),
			makeCurrentAddressRich: signal(true), nativeCurrencyTicker: 'ETH',
			richAccountBalances: signal<readonly RichAccountBalance[]>([1n, 2n].map((chainId) => ({ chainId, address: account.address, nativeAmount: chainId * 10n, tokenBalances: [] }))),
			richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal([]), changeRichSettings: requestRichSettingsChange,
		}
	function Harness() {
		controller = useRichModeTokens(inputs)
		return undefined
	}
	try {
		await act(() => { render(h(Harness, {}), dom.document.body) })
		assert.ok(controller)
		assert.equal(controller.accounts.data.value.controlsDisabled, true)
		await act(() => { chain.value = 1n })
		assert.equal(controller.accounts.data.value.controlsDisabled, false)
		await act(() => { controller?.accounts.actions.openBalances(account.address) })
		assert.equal(controller.editor.data.value.profile?.nativeAmount, 10n)
		assert.equal(controller.dialog.data.value.showRichBalanceDialog, true)
		await act(() => { chain.value = 2n })
		assert.equal(controller.dialog.data.value.showRichBalanceDialog, false)
		await act(() => { controller?.accounts.actions.openBalances(account.address) })
		assert.equal(controller.editor.data.value.profile?.nativeAmount, 20n)
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})

test('a multi-token batch keeps its original funding chain when the home snapshot changes between saves', async () => {
	const dom = installDomMock()
	const chain = signal<bigint | undefined>(1n)
	const account: AddressBookEntry = { type: 'contact', address: 1n, name: 'Funded account', entrySource: 'User' }
	const options: readonly RichTokenOption[] = [2n, 3n].map((tokenAddress) => ({ chainId: 1n, tokenAddress, tokenType: 'ERC20', tokenId: undefined, name: 'Token', symbol: 'TKN', decimals: 0n, amount: 10n, balanceSlot: undefined, erc1155StorageOrder: undefined, enabled: false }))
	const requestedChains: bigint[] = []
	const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: {
		sendMessage: async (message: unknown) => {
			const request = PopupMessage.parse(message)
			if (request.method !== 'popup_modifyRichToken') return undefined
			requestedChains.push(request.data.chainId)
			if (requestedChains.length === 1) {
				chain.value = 2n
				return { method: 'popup_modifyRichToken', result: { success: true, richToken: undefined, simulationRefresh: 'Refreshed' } }
			}
			return { method: 'popup_modifyRichToken', result: { success: false, error: 'The funding network changed.' } }
		},
	} } })
	let controller: RichModeTokenController | undefined
	const inputs: Parameters<typeof useRichModeTokens>[0] = {
			activeAddress: signal(account), richFundingChainId: chain, isInitialHomeDataLoaded: signal(true), isSettingsChangePending: signal(false),
			makeCurrentAddressRich: signal(true), nativeCurrencyTicker: 'ETH',
			richAccountBalances: signal([{ chainId: 1n, address: account.address, nativeAmount: 1n, tokenBalances: [] }]),
			richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal(options), changeRichSettings: requestRichSettingsChange,
		}
	function Harness() {
		controller = useRichModeTokens(inputs)
		return undefined
	}
	try {
		await act(() => { render(h(Harness, {}), dom.document.body) })
		assert.ok(controller)
		await act(() => {
			controller?.accounts.actions.openBalances(account.address)
			for (const option of options) controller?.picker.actions.toggleRichTokenSelection(option)
		})
		await act(async () => { await controller?.picker.actions.addSelectedRichTokens() })
		assert.deepEqual(requestedChains, [1n, 1n])
		assert.equal(controller.dialog.data.value.showRichBalanceDialog, false)
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
		if (originalBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', originalBrowser)
	}
})

for (const action of ['native', 'token-amount', 'add', 'remove'] as const) for (const success of [true, false]) test(`${ action } shares settings admission and releases controls after ${ success ? 'success' : 'failure' }`, async () => {
	const dom = installDomMock()
	const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const mutations: string[] = []
	let finishReply: (reply: unknown) => void = () => undefined
	const reply = new Promise<unknown>((resolve) => { finishReply = resolve })
	let finishReload: () => void = () => undefined
	const reload = new Promise<void>((resolve) => { finishReload = resolve })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: {
		onMessage: { addListener: () => undefined, removeListener: () => undefined },
		sendMessage: async (message: unknown) => {
			const request = PopupMessage.parse(message)
			if (request.method === 'popup_requestNewHomeData') return await reload
			if (request.method !== 'popup_modifyMakeMeRich' && request.method !== 'popup_modifyRichToken') return undefined
			mutations.push(request.method)
			return await reply
		},
	} } })
	const account: AddressBookEntry = { type: 'contact', address: 1n, name: 'Funded account', entrySource: 'User' }
	const option: RichTokenOption = { chainId: 1n, tokenAddress: 2n, tokenType: 'ERC20', tokenId: undefined, name: 'Token', symbol: 'TKN', decimals: 0n, amount: 10n, balanceSlot: undefined, erc1155StorageOrder: undefined, enabled: false }
	let controller: RichModeTokenController | undefined
	let settings: ReturnType<typeof usePopupSettingsChanges> | undefined
	const home: Parameters<typeof usePopupSettingsChanges>[0] = { isSettingsLoaded: signal(true), activeAddresses: signal([]), simulationMode: signal(true), rpcNetwork: signal(undefined), tabState: signal(undefined) }
	const fundingInputs: Omit<Parameters<typeof useRichModeTokens>[0], 'isSettingsChangePending' | 'changeRichSettings'> = {
		activeAddress: signal(account), richFundingChainId: signal(1n), isInitialHomeDataLoaded: signal(true),
		makeCurrentAddressRich: signal(true), nativeCurrencyTicker: 'ETH',
		richAccountBalances: signal([{ chainId: 1n, address: account.address, nativeAmount: 1n, tokenBalances: [] }]),
		richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal([option]),
	}
	function Harness() {
		settings = usePopupSettingsChanges(home)
		controller = useRichModeTokens({ ...fundingInputs, isSettingsChangePending: settings.isSettingsChangePending, changeRichSettings: settings.changeRichSettings })
		return undefined
	}
	try {
		await act(() => { render(h(Harness, {}), dom.document.body) })
		assert.ok(controller)
		assert.ok(settings)
		await act(() => { controller?.accounts.actions.openBalances(account.address) })
		let save: Promise<unknown> = Promise.resolve()
		await act(() => {
			if (controller === undefined) throw new Error('Expected controller')
			const actions = controller.editor.actions
			save = action === 'native' ? actions.saveNativeAmount(2n) : action === 'token-amount' ? actions.saveRichTokenAmount(option, 2n) : actions.setRichTokenEnabled(option, action === 'add')
		})
		assert.equal(settings.isSettingsChangePending.value, true)
		assert.equal(controller.accounts.data.value.controlsDisabled, true)
		assert.equal(controller.feedback.value.richTokenPending, true)
		await act(async () => {
			controller?.accounts.actions.enableMakeCurrentAddressRich(false)
			controller?.accounts.actions.modifyRichList(account, false)
			await controller?.editor.actions.saveNativeAmount(3n)
			await controller?.editor.actions.setRichTokenEnabled(option, true)
		})
		assert.equal(mutations.length, 1, 'competing rich actions must not dispatch')
		await assert.rejects(settings.setSimulationMode(false), /already in progress/u)
		await act(async () => {
			finishReply(action === 'native'
				? success ? { type: 'PopupSettingsChangeReply', ok: true } : { type: 'PopupSettingsChangeReply', ok: false, message: 'Funding rejected' }
				: { method: 'popup_modifyRichToken', result: success ? { success: true, richToken: undefined, simulationRefresh: 'Refreshed' } : { success: false, error: 'Funding rejected' } })
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		assert.equal(settings.isSettingsChangePending.value, false)
		assert.equal(controller.accounts.data.value.controlsDisabled, true, 'home-data reload still owns local progress after the coordinated reply')
		await act(() => { controller?.accounts.actions.enableMakeCurrentAddressRich(false) })
		assert.equal(mutations.length, 1)
		await act(async () => { finishReload(); await save })
		assert.equal(controller.accounts.data.value.controlsDisabled, false)
		assert.equal(controller.feedback.value.richTokenPending, false)
		assert.equal(controller.feedback.value.richTokenError, success ? undefined : 'Funding rejected')
	} finally {
		finishReply(undefined)
		finishReload()
		render(undefined, dom.document.body)
		dom.restore()
		if (originalBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', originalBrowser)
	}
})

test('failed native-amount and token changes reach the UI through the same non-throwing result', async () => {
	const dom = installDomMock()
	const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: {
		onMessage: { addListener: () => undefined, removeListener: () => undefined },
		sendMessage: async (message: unknown) => {
			const request = PopupMessage.parse(message)
			if (request.method === 'popup_modifyMakeMeRich') return { type: 'PopupSettingsChangeReply', ok: false, message: 'Native amount rejected' }
			if (request.method === 'popup_modifyRichToken') return { method: 'popup_modifyRichToken', result: { success: false, error: 'Token amount rejected' } }
			return undefined
		},
	} } })
	const account: AddressBookEntry = { type: 'contact', address: 1n, name: 'Funded account', entrySource: 'User' }
	const option: RichTokenOption = { chainId: 1n, tokenAddress: 2n, tokenType: 'ERC20', tokenId: undefined, name: 'Token', symbol: 'TKN', decimals: 0n, amount: 10n, balanceSlot: 9n, erc1155StorageOrder: undefined, enabled: true }
	let controller: RichModeTokenController | undefined
	const inputs: Parameters<typeof useRichModeTokens>[0] = {
		activeAddress: signal(account), richFundingChainId: signal(1n), isInitialHomeDataLoaded: signal(true), isSettingsChangePending: signal(false),
		makeCurrentAddressRich: signal(true), nativeCurrencyTicker: 'ETH',
		richAccountBalances: signal([{ chainId: 1n, address: account.address, nativeAmount: 1n, tokenBalances: [{ tokenAddress: option.tokenAddress, tokenId: undefined, amount: 10n }] }]),
		richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal([option]), changeRichSettings: requestRichSettingsChange,
	}
	function Harness() {
		controller = useRichModeTokens(inputs)
		return undefined
	}
	try {
		assert.deepEqual(await requestRichSettingsChange({ method: 'popup_modifyMakeMeRich', data: { action: 'set-native-amount', chainId: 1n, nativeAmount: 2n, address: account.address } }), { ok: false, error: 'Native amount rejected' })
		assert.deepEqual(await requestRichSettingsChange({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', chainId: 1n, address: account.address, tokenAddress: option.tokenAddress, tokenId: undefined, amount: 2n } }), { ok: false, error: 'Token amount rejected' })

		await act(() => { render(h(Harness, {}), dom.document.body) })
		await act(() => { controller?.accounts.actions.openBalances(account.address) })
		await act(async () => { await controller?.editor.actions.saveNativeAmount(2n) })
		assert.equal(controller?.feedback.value.richTokenError, 'Native amount rejected')
		assert.equal(controller?.feedback.value.richTokenErrorTarget, 'native')
		await act(async () => { await controller?.editor.actions.saveRichTokenAmount(option, 2n) })
		assert.equal(controller?.feedback.value.richTokenError, 'Token amount rejected')
		assert.equal(controller?.feedback.value.richTokenErrorTarget, '2:erc20')
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
		if (originalBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', originalBrowser)
	}
})
