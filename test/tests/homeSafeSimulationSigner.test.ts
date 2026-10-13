import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import { ICON_SIGNING } from '../../app/ts/utils/constants.js'
import type { TabState } from '../../app/ts/types/user-interface-types.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { flushMicrotasks } from '../harness/async.js'
import { replaceGlobal } from '../harness/globals.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, getButtonByText } from './domQueries.js'
import { createHomeParams, OTHER_SIGNER_ADDRESS, SAFE_ADDRESS, SAFE_SIGNER_ADDRESS, safeEntry } from './homePageTestHarness.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { getMessageWithMethod, hasMessageMethod } from './runtimeMessageMatchers.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('Home popup Gnosis Safe simulation signer', () => {
	test('disables the Gnosis Safe signer connect button and shows progress while MetaMask is opening', async () => {
		const dom = installDomMock()
		const animationFrames: FrameRequestCallback[] = []
		const connectRequest = Promise.withResolvers<void>()
		let restoreAnimationFrames: () => void = () => undefined
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: (message) =>
			hasMessageMethod(message, 'popup_requestAccountsFromSigner')
				? connectRequest.promise
				: undefined } })
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: undefined,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			restoreAnimationFrames = replaceGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
				animationFrames.push(callback)
				return animationFrames.length
			})
			const connectButton = getButtonByText(dom.document.body, 'Connect to MetaMask')
			await act(async () => {
				await clickElement(connectButton)
			})

			const pendingButton = getButtonByText(dom.document.body, 'Connecting to MetaMask')
			assert.notEqual(pendingButton.getAttribute('disabled'), null)
			assert.equal(pendingButton.getAttribute('aria-busy'), 'true')
			assert.notEqual(collectElements(pendingButton, 'svg').find((element) => element.getAttribute('class') === 'spinner'), undefined)
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_requestAccountsFromSigner')), false)

			await act(async () => {
				for (const callback of animationFrames.splice(0)) callback(0)
				await Promise.resolve()
			})
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_requestAccountsFromSigner')), false)
			await act(async () => {
				for (const callback of animationFrames.splice(0)) callback(0)
				await Promise.resolve()
			})
			assert.equal(browserMock.calls.runtimeSendMessage.filter((message) => hasMessageMethod(message, 'popup_requestAccountsFromSigner')).length, 1)

			connectRequest.resolve()
			await act(async () => {
				await connectRequest.promise
				await flushMicrotasks()
			})
		} finally {
			render(undefined, dom.document.body)
			restoreAnimationFrames()
			dom.restore()
		}
	})

	test('changes the Safe simulation signer from the popup in simulation mode', async () => {
		const dom = installDomMock()
		const selectionReply = Promise.withResolvers<{ type: 'SetSafeSimulationSignerReply', ok: true }>()
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: (message) =>
			hasMessageMethod(message, 'popup_setSafeSimulationSigner')
				? selectionReply.promise
				: undefined } })
		const activeAddresses = new Signal([safeEntry])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const signerDropdown = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('aria-label') === 'Safe signer in simulation: 0x4000000000000000000000000000000000000004'
			)
			if (signerDropdown === undefined) throw new Error('Missing Safe simulation signer dropdown')
			await act(async () => { await clickElement(signerDropdown) })
			const otherSignerOption = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('class')?.includes('dropdown-item') === true
				&& button.textContent.includes('0x5000000000000000000000000000000000000005') === true
			)
			if (otherSignerOption === undefined) throw new Error('Missing alternate Safe signer option')
			await act(async () => { await clickElement(otherSignerOption) })
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			assert.equal(collectElements(dom.document.body, 'button').some((button) =>
				button.getAttribute('aria-label') === 'Safe signer in simulation: 0x5000000000000000000000000000000000000005'
			), true)
			await act(async () => {
				await clickElement(otherSignerOption)
			})
			assert.equal(browserMock.calls.runtimeSendMessage.filter((message) => hasMessageMethod(message, 'popup_setSafeSimulationSigner')).length, 1)
			selectionReply.resolve({ type: 'SetSafeSimulationSignerReply', ok: true })
			await act(async () => {
				await flushMicrotasks()
			})

			const updateMessage = PopupMessage.parse(getMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_setSafeSimulationSigner'))
			assert.ok(updateMessage.method === 'popup_setSafeSimulationSigner', 'Missing Safe signer update message')
			const updatedSafe = updateMessage.data
			assert.equal(updatedSafe.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			assert.equal(updatedSafe.safeAddress, SAFE_ADDRESS)
			assert.equal(updatedSafe.chainId, 1n)
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			assert.equal(collectElements(dom.document.body, 'button').some((button) =>
				button.getAttribute('aria-label') === 'Safe signer in simulation: 0x5000000000000000000000000000000000000005'
			), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('rolls back only the simulation signer when optimistic persistence fails', async () => {
		const dom = installDomMock()
		const selectionReply = Promise.withResolvers<{ type: 'SetSafeSimulationSignerReply', ok: false, message: string }>()
		installBrowserMock({ handlers: { runtimeMessage: (message) =>
			hasMessageMethod(message, 'popup_setSafeSimulationSigner')
				? selectionReply.promise
				: undefined } })
		const activeAddresses = new Signal([safeEntry])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const signerDropdown = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('aria-label')?.startsWith('Safe signer in simulation:') === true
			)
			if (signerDropdown === undefined) throw new Error('Missing Safe simulation signer dropdown')
			await act(async () => { await clickElement(signerDropdown) })
			const alternateSignerOption = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('class')?.includes('dropdown-item') === true
				&& button.textContent.includes('0x5000000000000000000000000000000000000005') === true
			)
			if (alternateSignerOption === undefined) throw new Error('Missing alternate Safe signer option')
			await act(async () => { await clickElement(alternateSignerOption) })
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)

			activeAddresses.value = [{ ...safeEntry, name: 'Refreshed Treasury Safe', safeSimulationSignerAddress: OTHER_SIGNER_ADDRESS }]
			selectionReply.resolve({ type: 'SetSafeSimulationSignerReply', ok: false, message: 'Signer persistence failed.' })
			await act(async () => {
				await flushMicrotasks()
			})

			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, SAFE_SIGNER_ADDRESS)
			assert.equal(activeAddresses.value[0]?.name, 'Refreshed Treasury Safe')
			assert.equal(dom.document.body.textContent.includes('Signer persistence failed.'), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows the selected Safe simulation signer and retrieves missing owner choices', async () => {
		const dom = installDomMock()
		const safeStateReply = {
			method: 'popup_requestSafeContractState' as const,
			data: {
				chainId: '0x1',
				result: {
					ok: true as const,
					owners: [
						'0x4000000000000000000000000000000000000004',
						'0x5000000000000000000000000000000000000005',
					],
					ownerAddressBookEntries: [],
					version: '1.4.1',
				},
			},
		}
		let safeStateRequestCount = 0
		const pendingRefresh = Promise.withResolvers<typeof safeStateReply>()
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_setSafeSimulationSigner')) return { type: 'SetSafeSimulationSignerReply', ok: true }
			if (!hasMessageMethod(message, 'popup_requestSafeContractState')) return undefined
			safeStateRequestCount += 1
			return safeStateRequestCount === 1 ? safeStateReply : pendingRefresh.promise
		} } })
		const activeAddresses = new Signal([{ ...safeEntry, safeSignerAddresses: undefined }])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const signerDropdown = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('aria-label') === 'Safe signer in simulation: 0x4000000000000000000000000000000000000004'
			)
			if (signerDropdown === undefined) throw new Error('Missing selected Safe simulation signer')
			const retrieveOwnersButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Retrieve owners'))
			if (retrieveOwnersButton === undefined) throw new Error('Missing retrieve Safe owners button')
			await act(async () => {
				await clickElement(retrieveOwnersButton)
				await flushMicrotasks()
			})
			assert.deepEqual(activeAddresses.value[0]?.safeSignerAddresses, [SAFE_SIGNER_ADDRESS, OTHER_SIGNER_ADDRESS])
			assert.equal(activeAddresses.value[0]?.safeVersion, '1.4.1')
			const refreshMessage = PopupMessage.parse(getMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_setSafeSimulationSigner'))
			assert.ok(refreshMessage.method === 'popup_setSafeSimulationSigner', 'Missing persisted Safe owner refresh')
			assert.equal(refreshMessage.data.safeSimulationSignerAddress, SAFE_SIGNER_ADDRESS)
			await act(async () => { await clickElement(signerDropdown) })
			assert.equal(collectElements(dom.document.body, 'button').some((button) =>
				button.getAttribute('class')?.includes('dropdown-item') === true
				&& button.textContent.includes('0x5000000000000000000000000000000000000005') === true
			), true)
			assert.equal(collectElements(dom.document.body, 'data').some((data) =>
				data.textContent === '0x5000000000000000000000000000000000000005'
			), true)
			assert.equal(dom.document.body.textContent.includes('Safe owner'), false)
			assert.equal(dom.document.body.textContent.includes('(Not in addressbook)'), true)
			const refreshOwnersButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Refresh owners'))
			if (refreshOwnersButton === undefined) throw new Error('Missing refresh Safe owners button')
			act(() => { void clickElement(refreshOwnersButton) })
			await act(async () => { await Promise.resolve() })
			assert.equal(dom.document.body.textContent.includes('Refreshing...'), true)
			pendingRefresh.resolve(safeStateReply)
			await act(async () => { await flushMicrotasks() })
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('persists retrieved owners and clears a stale simulation signer when the first owner cannot simulate', async () => {
		const dom = installDomMock()
		const contractOwner = 0x6000000000000000000000000000000000000006n
		let signerUpdateCount = 0
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestSafeContractState')) return {
				method: 'popup_requestSafeContractState',
				data: {
					chainId: '0x1',
					result: {
						ok: true,
						owners: [
							'0x6000000000000000000000000000000000000006',
							'0x5000000000000000000000000000000000000005',
						],
						ownerAddressBookEntries: [],
						version: '1.4.1',
					},
				},
			}
			if (!hasMessageMethod(message, 'popup_setSafeSimulationSigner')) return undefined
			signerUpdateCount += 1
			return { type: 'SetSafeSimulationSignerReply', ok: true }
		} } })
		const activeAddresses = new Signal([{ ...safeEntry, safeSimulationSignerAddress: SAFE_SIGNER_ADDRESS, safeSignerAddresses: undefined }])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(true),
				})), dom.document.body)
			})

			const retrieveOwnersButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Retrieve owners'))
			if (retrieveOwnersButton === undefined) throw new Error('Missing retrieve Safe owners button')
			await act(async () => {
				await clickElement(retrieveOwnersButton)
				await flushMicrotasks()
			})

			assert.deepEqual(activeAddresses.value[0]?.safeSignerAddresses, [contractOwner, OTHER_SIGNER_ADDRESS])
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, undefined)
			assert.equal(signerUpdateCount, 1)
			const ownerRefreshMessage = PopupMessage.parse(getMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_setSafeSimulationSigner'))
			assert.ok(ownerRefreshMessage.method === 'popup_setSafeSimulationSigner', 'Missing persisted Safe owner refresh')
			assert.equal(ownerRefreshMessage.data.safeSimulationSignerAddress, undefined)
			const signerDropdown = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('aria-label') === 'Safe signer in simulation: Select signer'
			)
			if (signerDropdown === undefined) throw new Error('Missing unset Safe signer dropdown')
			await act(async () => { await clickElement(signerDropdown) })
			const eoaOwnerOption = collectElements(dom.document.body, 'button').find((button) =>
				button.getAttribute('class')?.includes('dropdown-item') === true
				&& button.textContent.includes('0x5000000000000000000000000000000000000005') === true
			)
			if (eoaOwnerOption === undefined) throw new Error('Missing selectable EOA Safe owner')
			await act(async () => {
				await clickElement(eoaOwnerOption)
				await flushMicrotasks()
			})
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			assert.equal(signerUpdateCount, 2)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('keeps visible Safe owner metadata unchanged when refreshed owners cannot be persisted', async () => {
		const dom = installDomMock()
		const initialSafe = { ...safeEntry, safeSignerAddresses: [SAFE_SIGNER_ADDRESS, OTHER_SIGNER_ADDRESS], safeVersion: '1.3.0' }
		const activeAddresses = new Signal([initialSafe])
		installBrowserMock({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestSafeContractState')) return {
				method: 'popup_requestSafeContractState',
				data: {
					chainId: '0x1',
					result: {
						ok: true,
						owners: ['0x5000000000000000000000000000000000000005'],
						ownerAddressBookEntries: [],
						version: '1.4.1',
					},
				},
			}
			if (hasMessageMethod(message, 'popup_setSafeSimulationSigner')) return { type: 'SetSafeSimulationSignerReply', ok: false, message: 'Owner metadata persistence failed.' }
			return undefined
		} } })
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(true),
				})), dom.document.body)
			})

			const refreshOwnersButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Refresh owners'))
			if (refreshOwnersButton === undefined) throw new Error('Missing refresh Safe owners button')
			await act(async () => {
				await clickElement(refreshOwnersButton)
				await flushMicrotasks()
			})

			assert.deepEqual(activeAddresses.value, [initialSafe])
			assert.equal(dom.document.body.textContent.includes('Owner metadata persistence failed.'), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('presents the wallet account instead of a stale unowned Safe as the current signing account', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [0x6000000000000000000000000000000000000006n, SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: 0x6000000000000000000000000000000000000006n,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent
			assert.equal(popupText.includes('0x6000000000000000000000000000000000000006'), true)
			assert.equal(popupText.includes('Gnosis Safe signers'), false)
			assert.equal(popupText.includes('CONNECTED'), true)
			assert.equal(popupText.includes('NOT CONNECTED'), false)
			assert.equal(popupText.includes('MetaMask has'), false)
			assert.equal(popupText.includes('selected. You cannot sign the current Gnosis Safe with it.'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
