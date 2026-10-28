import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { act } from 'preact/test-utils'
import { h, render } from 'preact'
import { App } from '../../app/ts/components/App.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { POPUP_PERFORMANCE_MARKS, clearPerformanceMarks } from '../../app/ts/utils/popupPerformance.js'
import { installDomMock } from './domMock.js'
import { collectElements, findElementByTagAndClass, hasClass } from './domQueries.js'
import { defaultHomePage, defaultHomePageBootstrap, defaultSettings, defaultTabState, hasAriaLabel, isButtonDisabled, loadedAddress, loadedAddressBookEntry } from './popupAppTestHarness.js'
import { hasMessageMethod, isHomeDataRequest } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('popup loading and bootstrap home data', () => {
	test('renders loading instead of default popup data while requesting bootstrap and fresh home data', async () => {
		clearPerformanceMarks()
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const loadingState = collectElements(dom.document.body, 'section').find((section) => section.getAttribute('aria-label') === 'Loading current popup state')
			assert.notEqual(loadingState, undefined)
			if (loadingState === undefined) throw new Error('Expected the popup loading placeholder')
			assert.equal(hasClass(loadingState, 'popup-home-card'), true)
			assert.notEqual(findElementByTagAndClass(loadingState, 'header', 'popup-home-header-layout'), undefined)
			assert.notEqual(findElementByTagAndClass(loadingState, 'div', 'active-address-row'), undefined)
			assert.equal(collectElements(loadingState, 'svg').some((svg) => hasClass(svg, 'spinner')), false)
			const loadingModeSelector = findElementByTagAndClass(loadingState, 'div', 'popup-home-mode-selector')
			if (loadingModeSelector === undefined) throw new Error('Expected the loading mode selector')
			const loadingModeControls = collectElements(loadingModeSelector, 'button').filter((element) => hasClass(element, 'button'))
			assert.deepEqual(loadingModeControls.map((control) => control.textContent), ['Simulating', 'Signing'])
			assert.equal(loadingModeControls.every((control) => hasClass(control, 'popup-loading-control')), true)
			assert.equal(loadingModeControls.every((control) => isButtonDisabled(control)), true)
			assert.notEqual(findElementByTagAndClass(loadingState, 'div', 'popup-home-rpc-selector'), undefined)
			assert.equal(dom.document.body.textContent.includes('vitalik.eth'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent.includes('Simulating') && !hasClass(button, 'popup-loading-control')), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent.includes('Signing') && !hasClass(button, 'popup-loading-control')), false)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.homeFirstCommit).length, 1)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.refreshRendered).length, 0)
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_requestHomePageBootstrap')), true)
			assert.equal(messaging.sentMessages.some((message) => isHomeDataRequest(message, false, false)), false)
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_refreshHomeData')), true)
		} finally {
			dom.restore()
			clearPerformanceMarks()
		}
	})

	test('does not render a full cached home snapshot while waiting for current data', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Cached simulation' }, 50, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}, 'cached'),
				})
			})

			assert.equal(hasAriaLabel(dom.document.body, 'Loading current popup state'), true)
			assert.equal(dom.document.body.textContent.includes('Loaded Account'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent.includes('Simulating') && !hasClass(button, 'popup-loading-control')), false)
		} finally {
			dom.restore()
		}
	})

	test('renders known signing mode and address from bootstrap home data', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const logoSlotBeforeHomeData = collectElements(dom.document.body, 'span').find((element) => hasClass(element, 'signer-logo-slot'))
			if (logoSlotBeforeHomeData === undefined) throw new Error('Expected the loading signer logo slot to reserve its resolved width')
			assert.equal(collectElements(logoSlotBeforeHomeData, 'img').length, 0)

			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			const homePageBootstrap = defaultHomePageBootstrap(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1, {
				activeAddresses: [loadedAddressBookEntry],
				activeSigningAddressInThisTab: loadedAddress,
				tabState: {
					...defaultTabState(1, { icon: ICON_SIGNING, iconReason: 'Signing' }),
					signerConnected: true,
					signerName: 'MetaMask',
					signerAccounts: [loadedAddress],
				},
			})
			await act(() => {
				messaging.dispatch({
					role: 'all',
					...homePageBootstrap,
				})
			})

			const logoSlotAfterCachedHomeData = collectElements(dom.document.body, 'span').find((element) => element.getAttribute('class')?.split(/\s+/).includes('signer-logo-slot'))
			if (logoSlotAfterCachedHomeData === undefined) throw new Error('Expected signer logo slot after bootstrap data loads')
			assert.equal(collectElements(logoSlotAfterCachedHomeData, 'img')[0]?.getAttribute('src'), '../img/signers/metamask.svg')
			assert.equal(collectElements(dom.document.body, 'section').some((section) => section.getAttribute('aria-label') === 'Loading current popup state'), false)
			assert.equal(collectElements(dom.document.body, 'div').some((div) => div.getAttribute('aria-label') === 'Loading active address'), false)
			assert.equal(dom.document.body.textContent.includes('Loaded Account'), true)
			const loadedHomeCard = findElementByTagAndClass(dom.document.body, 'section', 'popup-home-card')
			if (loadedHomeCard === undefined) throw new Error('Expected the loaded Home card')
			assert.notEqual(findElementByTagAndClass(loadedHomeCard, 'header', 'popup-home-header-layout'), undefined)
			assert.notEqual(findElementByTagAndClass(loadedHomeCard, 'div', 'active-address-row'), undefined)
			assert.notEqual(findElementByTagAndClass(loadedHomeCard, 'div', 'popup-home-rpc-selector'), undefined)
			const signingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Signing'))
			const simulatingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Simulating'))
			assert.equal(signingButton?.getAttribute('class')?.includes('button--secondary'), false)
			assert.equal(simulatingButton?.getAttribute('class')?.includes('button--secondary'), true)
		} finally {
			dom.restore()
		}
	})

	test('keeps only the missing active address loading after bootstrap home data arrives', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			const homePageBootstrap = defaultHomePageBootstrap(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1, {
				tabState: {
					...defaultTabState(1, { icon: ICON_SIGNING, iconReason: 'Signing' }),
					signerName: 'MetaMask',
				},
			})
			await act(() => {
				messaging.dispatch({
					role: 'all',
					...homePageBootstrap,
				})
			})

			assert.equal(collectElements(dom.document.body, 'section').some((section) => section.getAttribute('aria-label') === 'Loading current popup state'), false)
			const activeAddressLoading = collectElements(dom.document.body, 'div').find((div) => div.getAttribute('aria-label') === 'Loading active address')
			assert.ok(activeAddressLoading !== undefined)
			assert.equal(hasClass(activeAddressLoading, 'active-address-row'), true)
			assert.equal(hasClass(activeAddressLoading, 'popup-loading-address'), true)
			assert.equal(collectElements(dom.document.body, 'svg').some((svg) => svg.getAttribute('class') === 'spinner'), false)
			assert.equal(dom.document.body.textContent.includes('No address found'), false)
			assert.equal(dom.document.body.textContent.includes('NOT CONNECTED'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent.includes('Signing')), true)
		} finally {
			dom.restore()
		}
	})
})
