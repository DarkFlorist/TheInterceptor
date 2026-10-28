import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import type { TabState } from '../../app/ts/types/user-interface-types.js'
import { toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { ResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, getButtonByText, isDisabled } from './domQueries.js'
import { ACTIVE_ADDRESS, activeAddressEntry, createEmptySimulationResults, createHomeParams, SAFE_ADDRESS, SAFE_SIGNER_ADDRESS, safeEntry, safeSignerEntry } from './homePageTestHarness.js'

describe('Home popup active address selector', () => {
	test('treats a known signer account as connected even if the signerConnected flag is stale', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: false,
						signerName: 'MetaMask',
						signerAccounts: [ACTIVE_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIMULATING, iconReason: 'Connected through MetaMask.' },
						activeSigningAddress: ACTIVE_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(undefined),
					displayedSigningAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
					useSignersAddressAsActiveAddress: new Signal(true),
					simVisResults,
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIMULATING, iconReason: 'Connected through MetaMask.' }),
				})), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('CONNECTED'), true)
			assert.equal(dom.document.body.textContent.includes('NOT CONNECTED'), false)
		} finally {
			dom.restore()
		}
	})

	test('disables the active-address selector when signing mode has no Safe alternative', async () => {
		const dom = installDomMock()
		let changeActiveAddressCalls = 0
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					changeActiveAddress: () => { changeActiveAddressCalls++ },
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: false,
						signerName: 'NoSigner',
						signerAccounts: [],
						signerAccountError: undefined,
						signerChain: undefined,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'No signer wallet detected.' },
						activeSigningAddress: undefined,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(undefined),
					displayedSigningAddress: new Signal<bigint | undefined>(undefined),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'No signer wallet detected.' }),
				})), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('Connect a browser wallet to sign with the selected address.'), true)
			const changeButton = getButtonByText(dom.document.body, 'Change')
			assert.equal(isDisabled(changeButton), true)
			assert.equal(changeActiveAddressCalls, 0)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('enables the signing address selector when the signer owns a Safe alternative', async () => {
		const dom = installDomMock()
		let changeActiveAddressCalls = 0
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					changeActiveAddress: () => { changeActiveAddressCalls++ },
					activeAddresses: new Signal([activeAddressEntry, safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Connected through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(undefined),
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					useSignersAddressAsActiveAddress: new Signal(true),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Connected through MetaMask.' }),
				})), dom.document.body)
			})

			const changeButton = getButtonByText(dom.document.body, 'Change')
			assert.equal(isDisabled(changeButton), false)
			await act(async () => { await clickElement(changeButton) })
			assert.equal(changeActiveAddressCalls, 1)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows an unsaved signer address when it is active in simulation mode', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([activeAddressEntry]),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					useSignersAddressAsActiveAddress: new Signal(true),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent
			assert.equal(popupText.includes('0x4000000000000000000000000000000000000004'), true)
			assert.equal(popupText.includes('No address found'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows the named wallet-selected Safe owner with an address icon and without a signer selector in signing mode', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					walletSelectedAddressBookEntry: new Signal(safeSignerEntry),
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
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent
			assert.equal(popupText.includes('Treasury Safe'), true)
			assert.equal(popupText.includes('0x3000000000000000000000000000000000000003'), true)
			assert.equal(popupText.includes('MetaMask has'), true)
			assert.equal(popupText.includes('Safe owner account'), true)
			assert.equal(popupText.includes('0x4000000000000000000000000000000000000004'), false)
			const selectedSignerCard = collectElements(dom.document.body, 'span').find((element) =>
				element.getAttribute('class') === 'inline-card' && element.getAttribute('title') === 'Safe owner account'
			)
			if (selectedSignerCard === undefined) throw new Error('Missing wallet-selected Safe owner address card')
			assert.equal(collectElements(selectedSignerCard, 'svg').length > 0, true)
			assert.equal(popupText.includes('0x5000000000000000000000000000000000000005'), false)
			assert.equal(collectElements(dom.document.body, 'input').filter((element) => element.getAttribute('name') === 'active-safe-signer').length, 0)
			const signerOptions = collectElements(dom.document.body, 'label').filter((element) =>
				element.getAttribute('class')?.includes('safe-signer-option') === true
			)
			assert.equal(signerOptions.length, 0)
			assert.equal(popupText.includes('CONNECTED'), true)
			assert.equal(popupText.includes('NOT CONNECTED'), false)
			assert.equal(popupText.includes('You cannot sign the current Gnosis Safe with it.'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
