import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { flushMicrotasks } from '../harness/async.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, isDisabled } from './domQueries.js'
import { changeElement, createAbiLookupFailureReply, createIdentifyAddressReply, createSafeContractStateReply, loadPopupActionModules } from './popupAsyncActionTestHarness.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

// The app modules are imported after the browser globals exist, as in the extension; each test then installs its own mock.
installBrowserMock()
const installRuntimeMessaging = createRuntimeMessagingInstaller()

const modulesPromise = loadPopupActionModules()

describe('AddNewAddress lookups wait for background replies', () => {
	test('shows ABI lookup progress and a missing-reply error in AddNewAddress', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		let requestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async () => {
			requestCount += 1
			return requestCount === 1 ? deferredReply.promise : undefined
		}

		const modifyAddressWindowState = signal({
			windowStateId: 'window-1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract' as const,
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Governance Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})

		const rpcEntries = signal([{
			name: 'Ethereum Mainnet',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
			blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: '' },
		}])

		await act(() => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries,
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const fetchButton = buttons.find((button) => button.textContent.includes('Fetch from Block Explorer'))
		const modifyButton = buttons.find((button) => button.textContent.includes('Save changes'))
		const cancelButton = buttons.find((button) => button.textContent.includes('Cancel'))
		if (fetchButton === undefined || modifyButton === undefined || cancelButton === undefined) throw new Error('Expected address modal buttons to render')

		await act(async () => {
			await clickElement(fetchButton)
		})

		assert.match(fetchButton.textContent, /Fetching\.\.\./)
		assert.equal(isDisabled(fetchButton), true)
		assert.equal(isDisabled(modifyButton), true)
		assert.equal(isDisabled(cancelButton), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes(modules.BLOCK_EXPLORER_REPLY_MISSING_ERROR), true)
		assert.equal(dom.document.body.textContent.includes('Fetch from Block Explorer'), true)
		dom.restore()
	})

	test('ignores stale ABI lookup failures after the address changes', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const staleReply = createAbiLookupFailureReply('stale block explorer failure')
		const deferredReply = Promise.withResolvers<typeof staleReply>()
		messaging.browserMock.handlers.runtimeMessage = async () => deferredReply.promise

		const modifyAddressWindowState = signal({
			windowStateId: 'window-1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract' as const,
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Governance Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})

		const rpcEntries = signal([{
			name: 'Ethereum Mainnet',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
			blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: '' },
		}])

		await act(() => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries,
			}), dom.document.body)
		})

		const fetchButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Fetch from Block Explorer'))
		if (fetchButton === undefined) throw new Error('Expected block explorer fetch button to render')

		await act(async () => {
			await clickElement(fetchButton)
		})

		await act(async () => {
			modifyAddressWindowState.value = {
				...modifyAddressWindowState.value,
				incompleteAddressBookEntry: {
					...modifyAddressWindowState.value.incompleteAddressBookEntry,
					address: '0x0000000000000000000000000000000000000002',
				},
			}
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('Fetching...'), false)

		await act(async () => {
			deferredReply.resolve(staleReply)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('stale block explorer failure'), false)
		assert.equal(dom.document.body.textContent.includes('Fetch from Block Explorer'), true)
		dom.restore()
	})

	test('retries address identification after returning to a state whose earlier reply became stale', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const firstAddress = 1n
		const secondAddress = 2n
		const staleFirstReply = Promise.withResolvers<ReturnType<typeof createIdentifyAddressReply>>()
		let identifyRequestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) !== 'popup_requestIdentifyAddress') return undefined
			identifyRequestCount += 1
			if (identifyRequestCount === 1) return await staleFirstReply.promise
			if (identifyRequestCount === 2) return undefined
			return createIdentifyAddressReply(firstAddress, 'Retried token')
		}

		const modifyAddressWindowState = signal({
			windowStateId: 'window-1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				type: 'ERC20' as const,
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: undefined,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		})

		await act(async () => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries: signal([]),
			}), dom.document.body)
			await flushMicrotasks()
		})
		assert.equal(identifyRequestCount, 1)

		await act(async () => {
			modifyAddressWindowState.value = {
				...modifyAddressWindowState.value,
				incompleteAddressBookEntry: {
					...modifyAddressWindowState.value.incompleteAddressBookEntry,
					address: '0x0000000000000000000000000000000000000002',
				},
			}
			await flushMicrotasks()
		})
		assert.equal(identifyRequestCount, 2)

		await act(async () => {
			staleFirstReply.resolve(createIdentifyAddressReply(firstAddress, 'Stale token'))
			await staleFirstReply.promise
			await flushMicrotasks()
		})
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.address, `0x${ secondAddress.toString(16).padStart(40, '0') }`)
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.name, undefined)

		await act(async () => {
			modifyAddressWindowState.value = {
				...modifyAddressWindowState.value,
				incompleteAddressBookEntry: {
					...modifyAddressWindowState.value.incompleteAddressBookEntry,
					address: '0x0000000000000000000000000000000000000001',
				},
			}
			await flushMicrotasks()
		})

		assert.equal(identifyRequestCount, 3)
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.name, 'Retried token')
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.decimals, 18n)
		dom.restore()
	})

	test('shows cached Safe owners but blocks saving when automatic owner retrieval fails', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const safeAddress = '0x3000000000000000000000000000000000000003'
		const signerAddress = '0x1111111111111111111111111111111111111111'
		let saveMessage: unknown
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_requestIdentifyAddress') {
				return PopupRequestsReplies.popup_requestIdentifyAddress.serialize({
					method: 'popup_requestIdentifyAddress',
					data: { chainId: 1n, addressBookEntry: undefined },
				})
			}
			if (getMessageMethod(message) === 'popup_addOrModifyAddressBookEntry') {
				saveMessage = message
				return PopupRequestsReplies.popup_addOrModifyAddressBookEntry.serialize({ type: 'AddOrModifyAddressBookEntryReply', ok: true })
			}
			return undefined
		}
		const modifyAddressWindowState = signal({
			windowStateId: 'safe-window',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'safe' as const,
				address: safeAddress,
				askForAddressAccess: true,
				name: 'Treasury Safe',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: true,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
				safeSimulationSignerAddress: signerAddress,
				safeSignerAddresses: [signerAddress],
				safeVersion: '1.4.1',
			},
		})

		await act(async () => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries: signal([]),
			}), dom.document.body)
			await flushMicrotasks()
		})
		assert.equal(dom.document.body.textContent.includes(signerAddress), true)
		const modifyButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.trim() === 'Save changes')
		if (modifyButton === undefined) throw new Error('Expected Save changes button')
		assert.equal(isDisabled(modifyButton), true)
		await act(async () => { await clickElement(modifyButton) })
		assert.equal(saveMessage, undefined)
		render(undefined, dom.document.body)
		dom.restore()
	})

	test('refreshes visible Safe owners with pending feedback', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const firstOwner = 0x1111111111111111111111111111111111111111n
		const alternateOwner = 0x3333333333333333333333333333333333333333n
		const refreshedOwner = 0x2222222222222222222222222222222222222222n
		const firstReply = Promise.withResolvers<ReturnType<typeof createSafeContractStateReply>>()
		const refreshReply = Promise.withResolvers<ReturnType<typeof createSafeContractStateReply>>()
		let requestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_requestIdentifyAddress') return createIdentifyAddressReply(0x3000000000000000000000000000000000000003n, 'Treasury Safe')
			if (getMessageMethod(message) !== 'popup_requestSafeContractState') return undefined
			requestCount += 1
			return requestCount === 1 ? await firstReply.promise : await refreshReply.promise
		}
		const modifyAddressWindowState = signal({
			windowStateId: 'safe-refresh-window',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'safe' as const,
				address: '0x3000000000000000000000000000000000000003',
				askForAddressAccess: true,
				name: 'Treasury Safe',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User' as const,
				abi: undefined,
				useAsActiveAddress: true,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
				safeSimulationSignerAddress: undefined,
				safeSignerAddresses: [],
				safeVersion: undefined,
			},
		})

		await act(async () => {
			render(h(modules.AddNewAddress, {
				close: () => undefined,
				setActiveAddressAndInformAboutIt: undefined,
				modifyAddressWindowState,
				activeAddress: undefined,
				rpcEntries: signal([{
					name: 'Ethereum',
					chainId: 1n,
					httpsRpc: 'https://example.invalid',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					primary: true,
					minimized: false,
				}]),
			}), dom.document.body)
			await flushMicrotasks()
		})
		const retrieveButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Retrieving...'))
		if (retrieveButton === undefined) throw new Error('Expected pending Safe signer retrieval button')
		assert.equal(isDisabled(retrieveButton), true)
		assert.equal(requestCount, 1)
		await act(async () => {
			firstReply.resolve(createSafeContractStateReply([firstOwner, alternateOwner]))
			await firstReply.promise
			await flushMicrotasks()
		})
		assert.equal(dom.document.body.textContent.includes('Safe Owner 1'), true)
		const ownerOptions = collectElements(dom.document.body, 'input').filter((input) => input.getAttribute('name') === 'safe-simulation-signer')
		assert.equal(ownerOptions.length, 2)
		assert.equal(dom.document.body.textContent.includes('Safe Owner 2'), true)
		const alternateOwnerOption = ownerOptions.find((input) => input.getAttribute('value') === '0x3333333333333333333333333333333333333333')
		if (alternateOwnerOption === undefined) throw new Error('Expected alternate Safe owner radio option')
		const alternateOwnerLabel = alternateOwnerOption.parentNode
		if (alternateOwnerLabel === undefined || alternateOwnerLabel === null) throw new Error('Expected alternate Safe owner label')
		assert.equal(collectElements(alternateOwnerLabel, 'button').length, 0)
		await act(async () => { await changeElement(alternateOwnerOption) })
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.safeSimulationSignerAddress, '0x3333333333333333333333333333333333333333')
		const refreshButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Refresh owners'))
		if (refreshButton === undefined) throw new Error('Expected Safe signer refresh button')
		await act(async () => {
			void clickElement(refreshButton)
			await Promise.resolve()
		})
		assert.equal(dom.document.body.textContent.includes('Refreshing...'), true)
		assert.equal(isDisabled(refreshButton), true)

		await act(async () => {
			refreshReply.resolve(createSafeContractStateReply([refreshedOwner]))
			await refreshReply.promise
			await flushMicrotasks()
		})
		assert.equal(requestCount, 2)
		assert.equal(modifyAddressWindowState.value.incompleteAddressBookEntry.safeSimulationSignerAddress, '0x2222222222222222222222222222222222222222')
		render(undefined, dom.document.body)
		dom.restore()
	})
})
