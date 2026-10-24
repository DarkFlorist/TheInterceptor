import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { usePopupSettingsChanges } from '../../app/ts/components/hooks/usePopupSettingsChanges.js'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { App } from '../../app/ts/components/App.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { CompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { flushMicrotasks } from '../harness/async.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, getButtonByText, hasClass } from './domQueries.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'
import { AddressSelectionProbe, createRichAddressEntry, createSimulatedCompleteVisualizedSimulation, createSimulationStackHomePageUpdate, createSimulationStateChangedMessage, createStackHomePageUpdate, deliverHomePageUpdate, deliverPopupMessage, hasButtonWithAriaLabel } from './simulationVisualizerTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('popup and stack visualizer settings synchronization', () => {
	test('popup displays shared pending work and ignores an older busy status after completion', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => { render(h(App, {}), dom.document.body) })
			await act(() => { deliverHomePageUpdate(messaging, createSimulationStackHomePageUpdate(25, 1, 'Popup')) })
			assert.ok(messaging.sentMessages.some((message) => PopupMessage.safeParse(message).success && hasMessageMethod(message, 'popup_requestSettingsChangeStatus')))
			const status = async (revision: number, operation: 'rpc' | undefined) => await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsChangeStatus', data: { revision, operation } })
			})
			await status(10, 'rpc')
			assert.ok(dom.document.body.textContent.includes('Changing network. Check your wallet'))
			assert.equal(String(getButtonByText(dom.document.body, 'Change').getAttribute('disabled')), 'true')
			await status(11, undefined)
			await status(10, 'rpc')
			assert.equal(dom.document.body.textContent.includes('Changing network. Check your wallet'), false)
			assert.equal(getButtonByText(dom.document.body, 'Change').getAttribute('disabled'), undefined)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('signer selection reveals the current wallet account before permission work finishes', async () => {
		const dom = installDomMock()
		const changeReply = Promise.withResolvers<unknown>()
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			const parsed = PopupMessage.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_changeActiveAddress' ? changeReply.promise : undefined
		} } })
		function Harness() {
			const home = useLiveSimulationHomeData({ answerMainPopupOpen: true, answerSimulationDataConsumerOpen: true, requestFreshHomeDataOnMount: false })
			const changes = usePopupSettingsChanges(home)
			return h('div', {}, [
				h('button', { onClick: () => changes.setActiveAddressAndInformAboutIt('signer') }, 'Select signer'),
				h('span', {}, `${home.displayedSigningAddress.value}:${changes.isActiveAddressChanging.value}:${changes.isActiveAddressChangePending.value}`),
			])
		}
		try {
			await act(() => { render(h(Harness, {}), dom.document.body) })
			const initial = createStackHomePageUpdate(25, 1, 'Signing popup')
			await act(() => { deliverHomePageUpdate(messaging, initial) })
			// Start the request without awaiting its deliberately delayed permission-work reply.
			await act(() => { void clickElement(getButtonByText(dom.document.body, 'Select signer')) })
			assert.ok(dom.document.body.textContent.includes(':true:true'))
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: { ...initial.data.settings, activeSigningSafeAddress: undefined }, popupRefreshGeneration: 2 })
			})
			assert.ok(dom.document.body.textContent.includes(`${initial.data.tabState.activeSigningAddress}:false:true`))
			// A newer authoritative selection must survive the original request's eventual reply.
			await act(() => { deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 3 }) })
			await act(async () => {
				changeReply.resolve({ type: 'ChangeActiveAddressReply', ok: true })
				await changeReply.promise
				await flushMicrotasks()
			})
			assert.ok(dom.document.body.textContent.includes(`${initial.data.settings.activeSigningSafeAddress}:false:false`))
		} finally {
			changeReply.resolve(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('popup reveals the committed wallet before the address-change reply and preserves later settings', async () => {
		const dom = installDomMock()
		const changeReply = Promise.withResolvers<unknown>()
		let changeRequested = false
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			const parsed = PopupMessage.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_changeActiveAddress') {
				changeRequested = true
				return changeReply.promise
			}
			return undefined
		} } })
		try {
			await act(() => { render(h(App, {}), dom.document.body) })
			const initial = createSimulationStackHomePageUpdate(25, 1, 'Simulation popup')
			const nextEntry = createRichAddressEntry(2n, 'Next wallet')
			await act(() => {
				deliverHomePageUpdate(messaging, { ...initial, data: { ...initial.data, activeAddresses: [...initial.data.activeAddresses, nextEntry] } })
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Change'))
				await flushMicrotasks()
			})
			await act(async () => { await import('../../app/ts/components/pages/ChangeActiveAddress.js') })
			const nextCard = collectElements(dom.document.body, 'div').find((element) => element.getAttribute('class') === 'card hoverable' && element.textContent.includes('Next wallet'))
			if (nextCard === undefined) throw new Error('Expected the next wallet in the address picker')
			await act(async () => { await clickElement(nextCard) })
			assert.ok(changeRequested)
			const addressRow = () => collectElements(dom.document.body, 'div').find((element) => hasClass(element, 'active-address-row'))
			assert.equal(addressRow()?.getAttribute('aria-label'), 'Switching active address')
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 2 })
			})
			assert.equal(addressRow()?.getAttribute('aria-label'), 'Switching active address')
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: { ...initial.data.settings, activeSimulationAddress: 2n }, popupRefreshGeneration: 3 })
			})
			assert.equal(addressRow()?.textContent.includes('Next wallet'), true)
			assert.equal(String(getButtonByText(dom.document.body, 'Change').getAttribute('disabled')), 'true')
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 4 })
			})
			await act(async () => {
				changeReply.resolve({ type: 'ChangeActiveAddressReply', ok: true })
				await changeReply.promise
				await flushMicrotasks()
			})
			assert.equal(addressRow()?.textContent.includes('Simulation address'), true)
			assert.equal(getButtonByText(dom.document.body, 'Change').getAttribute('disabled'), undefined)
		} finally {
			changeReply.resolve(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('reveals committed address settings while withholding stale simulation and older settings', async () => {
		const dom = installDomMock()
		const refresh = Promise.withResolvers<unknown>()
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => (
			hasMessageMethod(message, 'popup_requestCompleteVisualizedSimulation')
				? refresh.promise : undefined
		) } })
		try {
			await act(() => { render(h(AddressSelectionProbe, {}), dom.document.body) })
			const initial = createSimulationStackHomePageUpdate(25, 1, 'Simulation popup')
			await act(() => { deliverHomePageUpdate(messaging, initial) })
			const settings = { ...initial.data.settings, activeSimulationAddress: 2n }
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration: 3 })
			})
			assert.equal(dom.document.body.textContent, '2/passthrough/loading')
			await act(() => {
				deliverPopupMessage(messaging, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 2 })
				deliverHomePageUpdate(messaging, initial)
				deliverPopupMessage(messaging, createSimulationStateChangedMessage(initial.data.visualizedSimulatorState))
			})
			assert.equal(dom.document.body.textContent, '2/passthrough/loading')
			await act(async () => {
				refresh.resolve({ method: 'popup_requestCompleteVisualizedSimulation', visualizedSimulatorState: serialize(CompleteVisualizedSimulation, createSimulatedCompleteVisualizedSimulation(settings)) })
				await refresh.promise
				await flushMicrotasks()
			})
			assert.equal(dom.document.body.textContent, '2/simulated/done')
		} finally {
			refresh.resolve(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('open stack visualizer switches modes immediately when settings change', async () => {
		const dom = installDomMock()
		const visualizationRefresh = Promise.withResolvers<unknown>()
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => (
			hasMessageMethod(message, 'popup_requestCompleteVisualizedSimulation')
				? visualizationRefresh.promise
				: undefined
		) } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const safeUpdate = createStackHomePageUpdate(25, 1, 'Safe stack tab')

			await act(() => {
				deliverHomePageUpdate(messaging, safeUpdate)
			})
			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)

			await act(() => {
				deliverPopupMessage(messaging, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: { ...safeUpdate.data.settings, simulationMode: true },
				})
			})
			assert.equal(dom.document.body.textContent.includes('Simulation Stack'), true)
			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), false)

			await act(() => {
				deliverPopupMessage(messaging, createSimulationStateChangedMessage(safeUpdate.data.visualizedSimulatorState))
			})
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), false)

			await act(() => {
				deliverHomePageUpdate(messaging, {
						...safeUpdate,
						homeDataSource: 'cached',
						popupRefreshGeneration: 3,
						data: {
							...safeUpdate.data,
							settings: { ...safeUpdate.data.settings, simulationMode: true },
						},
					})
			})
			assert.equal(dom.document.body.textContent.includes('Simulation Stack'), true)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), false)

			await act(async () => {
				visualizationRefresh.resolve(undefined)
				await visualizationRefresh.promise
				await Promise.resolve()
			})
			await act(() => {
				deliverPopupMessage(messaging, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation({
					...safeUpdate.data.settings,
					simulationMode: true,
				})))
			})
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)

			await act(() => {
				deliverPopupMessage(messaging, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 4,
					data: safeUpdate.data.settings,
				})
			})
			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent.includes('Simulation Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer releases its refresh barrier when the active Safe changes independently', async () => {
		const dom = installDomMock()
		const visualizationRefresh = Promise.withResolvers<unknown>()
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => (
			hasMessageMethod(message, 'popup_requestCompleteVisualizedSimulation')
				? visualizationRefresh.promise
				: undefined
		) } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const simulationUpdate = createSimulationStackHomePageUpdate(27, 1, 'Simulation stack tab')
			const safeSettings = createStackHomePageUpdate(27, 2, 'Safe stack tab').data.settings

			await act(() => {
				deliverHomePageUpdate(messaging, simulationUpdate)
				deliverPopupMessage(messaging, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: safeSettings,
				})
			})
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), false)

			await act(() => {
				deliverPopupMessage(messaging, {
					role: 'all',
					method: 'popup_activeSigningAddressChanged',
					data: {
						tabId: 27,
						activeSigningAddress: 0x1000000000000000000000000000000000000001n,
						activeSigningSafeAddress: 0x4000000000000000000000000000000000000004n,
					},
				})
			})
			await act(async () => {
				visualizationRefresh.resolve(undefined)
				await visualizationRefresh.promise
				await Promise.resolve()
			})
			await act(() => {
				deliverPopupMessage(messaging, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation({
					...safeSettings,
					activeSigningSafeAddress: 0x4000000000000000000000000000000000000004n,
				})))
			})
			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
		} finally {
			dom.restore()
		}
	})
})
