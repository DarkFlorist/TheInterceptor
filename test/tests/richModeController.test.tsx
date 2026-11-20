import * as assert from 'node:assert'
import { test } from 'bun:test'
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
			richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal([]), setRichState: async () => undefined,
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
			richList: signal([]), richNativeAmount: signal(1n), richTokenOptions: signal(options), setRichState: async () => undefined,
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
