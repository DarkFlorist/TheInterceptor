import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { act } from 'preact/test-utils'
import { h, render } from 'preact'
import { App } from '../../app/ts/components/App.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { replaceProperty } from '../harness/globals.js'
import { installClipboardEventMock, installClipboardMock } from './clipboardTestDoubles.js'
import { installDomMock } from './domMock.js'
import { collectElements, findElementByTagAndClass, hasClass } from './domQueries.js'
import { clickPopupElement, defaultHomePage, defaultHomePageBootstrap, defaultSettings, hasAriaLabel, isButtonDisabled, loadedAddress, loadedAddressBookEntry } from './popupAppTestHarness.js'
import { hasMessageMethod, isHomeDataRequest } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('popup refresh requests for live updates', () => {
	test('requests fresh data for live updates while the initial refresh is pending', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			messaging.sentMessages.splice(0)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_signer_name_changed',
				})
			})

			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_refreshHomeData')), true)
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_requestNewHomeData')), false)
		} finally {
			dom.restore()
		}
	})

	test('accepts fresh data for a newly active tab after rendering bootstrap data', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const buttonsBeforeHomeData = collectElements(dom.document.body, 'button').filter((button) => !hasClass(button, 'popup-loading-control'))
			const signingButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent.includes('Signing'))
			const rpcButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent.includes('Ethereum Mainnet'))
			const timePickerModeButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent.includes('For'))
			const timePickerDeltaButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent.includes('Seconds'))
			const editButtonsBeforeHomeData = buttonsBeforeHomeData.filter((button) => button.textContent.toLowerCase().includes('edit'))
			const copyButtonsBeforeHomeData = buttonsBeforeHomeData.filter((button) => button.textContent.toLowerCase().includes('copy'))
			const richCheckboxBeforeHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute('type') === 'checkbox')
			const timePickerDeltaInputBeforeHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute('type') === 'number' && !hasClass(input, 'popup-loading-control'))
			assert.equal(signingButtonBeforeHomeData, undefined)
			assert.equal(rpcButtonBeforeHomeData, undefined)
			assert.equal(timePickerModeButtonBeforeHomeData, undefined)
			assert.equal(timePickerDeltaButtonBeforeHomeData, undefined)
			assert.equal(editButtonsBeforeHomeData.length, 0)
			assert.equal(copyButtonsBeforeHomeData.length, 0)
			assert.deepEqual(clipboardMock.copiedText, [])
			assert.equal(richCheckboxBeforeHomeData, undefined)
			assert.equal(timePickerDeltaInputBeforeHomeData, undefined)

			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			const bootstrapHomePage = defaultHomePageBootstrap(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 10, {
				activeAddresses: [loadedAddressBookEntry],
				settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
			})
			await act(() => {
				messaging.dispatch({
					role: 'all',
					...bootstrapHomePage,
				})
			})

			const buttonsAfterHomeData = collectElements(dom.document.body, 'button').filter((button) => !hasClass(button, 'popup-loading-control'))
			const simulatingButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent.includes('Simulating'))
			const rpcButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent.includes('Ethereum'))
			const timePickerModeButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent.includes('For'))
			const timePickerDeltaButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent.includes('Seconds'))
			const editButtonsAfterHomeData = buttonsAfterHomeData.filter((button) => button.textContent.toLowerCase().includes('edit'))
			const copyButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent.toLowerCase().includes('copy'))
			const timePickerDeltaInputAfterHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute('type') === 'number' && !hasClass(input, 'popup-loading-control'))
			assert.equal(simulatingButtonAfterHomeData?.getAttribute('class')?.includes('button--secondary'), false)
			assert.equal(isButtonDisabled(rpcButtonAfterHomeData), false)
			assert.equal(timePickerModeButtonAfterHomeData, undefined)
			assert.equal(timePickerDeltaButtonAfterHomeData, undefined)
			assert.equal(editButtonsAfterHomeData.length > 0, true)
			assert.notEqual(copyButtonAfterHomeData, undefined)
			if (copyButtonAfterHomeData === undefined) throw new Error('Expected active address copy action after home data loads')
			await act(async () => {
				await clickPopupElement(copyButtonAfterHomeData)
			})
			assert.deepEqual(clipboardMock.copiedText, [checksummedAddress(loadedAddress)])
			assert.equal(timePickerDeltaInputAfterHomeData, undefined)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading simulation controls'), true)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading current simulation state'), true)
			const loadingSimulationControls = collectElements(dom.document.body, 'div').find((element) => element.getAttribute('aria-label') === 'Loading simulation controls')
			const loadingSimulationState = collectElements(dom.document.body, 'div').find((element) => element.getAttribute('aria-label') === 'Loading current simulation state')
			assert.ok(loadingSimulationControls !== undefined && loadingSimulationState !== undefined)
			assert.equal(hasClass(loadingSimulationControls, 'popup-simulation-controls'), true)
			assert.notEqual(findElementByTagAndClass(loadingSimulationControls, 'div', 'time-picker-row'), undefined)
			assert.notEqual(findElementByTagAndClass(loadingSimulationState, 'div', 'simulation-results-header'), undefined)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(2, { icon: ICON_SIMULATING, iconReason: 'Fresh tab' }, 2, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}),
				})
			})
			const buttonsAfterFreshHomeData = collectElements(dom.document.body, 'button')
			assert.equal(isButtonDisabled(buttonsAfterFreshHomeData.find((button) => button.textContent.includes('For'))), false)
			assert.equal(isButtonDisabled(buttonsAfterFreshHomeData.find((button) => button.textContent.includes('Seconds'))), false)
			assert.equal(isButtonDisabled(collectElements(dom.document.body, 'input').find((input) => input.getAttribute('type') === 'number')), false)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading simulation controls'), false)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading current simulation state'), false)
			assert.notEqual(findElementByTagAndClass(dom.document.body, 'div', 'popup-simulation-controls'), undefined)
			assert.notEqual(findElementByTagAndClass(dom.document.body, 'div', 'time-picker-row'), undefined)
			assert.notEqual(findElementByTagAndClass(dom.document.body, 'div', 'simulation-results-header'), undefined)
			assert.equal(dom.document.body.textContent.includes('tab-2.invalid'), true)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('ignores pasted addresses until initial home data arrives', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const clipboardEvents = installClipboardEventMock()
		const pasteListeners: ((event: Event) => void)[] = []
		const pastedAddress = '0x2000000000000000000000000000000000000002'
		replaceProperty(globalThis.window, 'addEventListener', (type: string, listener: (event: Event) => void) => {
			if (type === 'paste') pasteListeners.push(listener)
		})
		// The paste catcher re-registers its window listener whenever it is enabled or disabled, so a paste reaches the newest listener.
		const pasteIntoPopup = (text: string) => {
			const pasteListener = pasteListeners.at(-1)
			assert.ok(pasteListener !== undefined, 'Expected the popup to listen for paste events')
			pasteListener(clipboardEvents.createPasteEvent(text))
		}
		try {
			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			messaging.sentMessages.splice(0)
			await act(() => {
				pasteIntoPopup(pastedAddress)
			})
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_changePage')), false)

			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 1, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}),
				})
			})

			messaging.sentMessages.splice(0)
			await act(() => {
				pasteIntoPopup(pastedAddress)
			})
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_changePage')), true)
		} finally {
			dom.restore()
			clipboardEvents.restore()
		}
	})

	test('requests signer refresh for signer-related live updates', async () => {
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
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1),
				})
			})
			messaging.sentMessages.splice(0)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_signer_name_changed',
				})
			})

			assert.equal(messaging.sentMessages.some((message) => isHomeDataRequest(message, true, true)), true)
		} finally {
			dom.restore()
		}
	})

	test('requests cached export availability without a full refresh after live simulation updates', async () => {
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
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 1),
				})
			})
			messaging.sentMessages.splice(0)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_simulation_state_changed',
					data: { visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation() },
				})
			})

			assert.equal(messaging.sentMessages.some((message) => isHomeDataRequest(message, false, false)), true)
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_refreshHomeData')), false)
		} finally {
			dom.restore()
		}
	})
})
