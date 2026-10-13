import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { flushMicrotasks } from '../harness/async.js'
import { installClipboardMock } from './clipboardTestDoubles.js'
import { installDomMock } from './domMock.js'
import { clickElement, getButtonByText } from './domQueries.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'
import { createNonSafeStackHomePageUpdate, createSimulationStackHomePageUpdate, createStackHomePageUpdate, deliverHomePageUpdate, deliverPopupMessage, hasButtonWithAriaLabel } from './simulationVisualizerTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('stack visualizer export and Gnosis Safe controls', () => {
	test('stack visualizer export button copies the simulation stack export payload', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const exportPayload = '{ "name": "Interceptor Simulation Export" }'
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestInterceptorSimulationInput')) {
				return { method: 'popup_requestInterceptorSimulationInput', ok: true, ethSimulateV1InputString: exportPayload }
			}
			return undefined
		} } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createSimulationStackHomePageUpdate(19, 1, 'Stack tab'))
			})

			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await flushMicrotasks()
			})

			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_requestInterceptorSimulationInput')), true)
			assert.deepStrictEqual(clipboardMock.copiedText, [exportPayload])
			assert.equal(dom.document.body.textContent.includes('Copied!'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute('disabled'), null)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('stack visualizer hides a simulation export error after switching to Safe mode', async () => {
		const dom = installDomMock()
		const exportError = 'Simulation stack export failed.'
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestInterceptorSimulationInput')) {
				return { method: 'popup_requestInterceptorSimulationInput', ok: false, message: exportError }
			}
			return undefined
		} } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const simulationUpdate = createSimulationStackHomePageUpdate(26, 1, 'Simulation stack tab')
			await act(() => {
				deliverHomePageUpdate(messaging, simulationUpdate)
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await flushMicrotasks()
			})
			assert.equal(dom.document.body.textContent.includes(exportError), true)

			await act(async () => {
				deliverPopupMessage(messaging, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: { ...simulationUpdate.data.settings, simulationMode: false },
				})
				await Promise.resolve()
			})
			assert.equal(dom.document.body.textContent.includes(exportError), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer Safe export copies with feedback and a cooldown', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const safeExportPayload = '{ "name": "Interceptor Safe Stack" }'
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestSafeStackExport')) {
				return { method: 'popup_requestSafeStackExport', ok: true, safeStackJson: safeExportPayload }
			}
			return undefined
		} } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(24, 1, 'Stack tab'))
			})

			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await flushMicrotasks()
			})

			assert.deepStrictEqual(clipboardMock.copiedText, [safeExportPayload])
			assert.equal(dom.document.body.textContent.includes('Copied!'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute('disabled'), null)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('stack visualizer hides simulation import and export in Safe signing mode', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(20, 1, 'Stack tab'))
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer shows the reason when copying Safe transactions is refused', async () => {
		const dom = installDomMock()
		const exportError = 'The simulation stack has no Safe proposals to export.'
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: (message) => {
			if (hasMessageMethod(message, 'popup_requestSafeStackExport')) {
				return { method: 'popup_requestSafeStackExport', ok: false, message: exportError }
			}
			return undefined
		} } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(21, 1, 'Stack tab'))
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await flushMicrotasks()
			})

			assert.equal(dom.document.body.textContent.includes(exportError), true)

		} finally {
			dom.restore()
		}
	})

	test('stack visualizer shows Safe actions only when signing with an active Safe', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: () => undefined } })
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const update = createStackHomePageUpdate(23, 1, 'Stack tab')
			const activeSafe = update.data.activeAddresses[0]
			if (activeSafe?.type !== 'safe') throw new Error('Expected a Safe fixture')
			const contactWithSafeAddress: AddressBookEntry = { type: 'contact', name: 'Safe address contact', address: activeSafe.address, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }

			await act(() => {
				deliverHomePageUpdate(messaging, createNonSafeStackHomePageUpdate(23, 2, 'Non-Safe stack tab'))
			})

			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), false)
			assert.equal(dom.document.body.textContent.includes('Select simulation mode or a Gnosis Safe to view a transaction stack.'), true)

			await act(() => {
				deliverHomePageUpdate(messaging, { ...update, popupRefreshGeneration: 3, data: { ...update.data, activeAddresses: [contactWithSafeAddress, { ...activeSafe, safeSimulationSignerAddress: undefined }], hasSafeTransactionsToExport: false } })
			})

			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute('disabled'), null)
			assert.equal(getButtonByText(dom.document.body, 'Export').getAttribute('title'), 'There are no Gnosis Safe proposals to export on the selected chain.')

			await act(() => {
				deliverHomePageUpdate(messaging, { ...update, popupRefreshGeneration: 4, data: { ...update.data, tabState: { ...update.data.tabState, signerAccounts: [0x9999999999999999999999999999999999999999n] } } })
			})

			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer switches between mutually exclusive Safe and simulation controls', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(22, 1, 'Stack tab'))
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)

			await act(() => {
				deliverHomePageUpdate(messaging, createSimulationStackHomePageUpdate(22, 2, 'Simulation stack tab'))
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
		} finally {
			dom.restore()
		}
	})
})
