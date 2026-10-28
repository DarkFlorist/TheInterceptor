import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, findElementByTagAndClass, getButtonByText, getElementChildren, hasAncestorWithClass, hasClass } from './domQueries.js'
import { isHomeDataRequest } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'
import { createFailedStackHomePageUpdate, createRichListElement, createSerializableRichHomePageUpdate, createSerializableSettings, createSimulatedCompleteVisualizedSimulation, createSimulationStackHomePageUpdate, createSimulationStateChangedMessage, createStackHomePageUpdate, deliverHomePageUpdate, deliverPopupMessage, findElementById, getFirstElementChild, getParagraphByAriaLabel, getRichAddressGroups, hasButtonWithAriaLabel, hasButtonWithText, hasCompactStackCard } from './simulationVisualizerTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('stack visualizer page rendering', () => {
	test('stack visualizer page shows rich-only state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
			createRichListElement(0x2000000000000000000000000000000000000002n, 'Treasury Two'),
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury, Cold'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createSerializableRichHomePageUpdate(12, 1, 'Rich tab', 3, richList))
			})

			assert.equal(dom.document.body.textContent.includes('Simply making 3 addresses rich'), true)
			assert.equal(dom.document.body.textContent.includes('Addresses being made rich are'), true)
			assert.equal(dom.document.body.textContent.includes('Treasury One'), true)
			assert.equal(dom.document.body.textContent.includes('Treasury Two'), true)
			assert.equal(dom.document.body.textContent.includes('Treasury, Cold'), true)
			const richAddressParagraph = getParagraphByAriaLabel(dom.document.body, 'Addresses being made rich are Treasury One, Treasury Two and Treasury, Cold.')
			const richAddressGroups = getRichAddressGroups(richAddressParagraph)
			assert.equal(richAddressGroups.length, 3)
			assert.equal(richAddressGroups[0]?.textContent.endsWith(','), true)
			assert.equal(richAddressGroups[2]?.textContent.startsWith(' and '), true)
			assert.equal(richAddressGroups[2]?.textContent.includes('Treasury, Cold'), true)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), false)
			assert.equal(collectElements(dom.document.body, 'nav').some((nav) => hasClass(nav, 'window-header')), false)
			assert.ok(findElementByTagAndClass(dom.document.body, 'div', 'simulation-stack-page'))
			const richHeader = collectElements(dom.document.body, 'header').find((header) => header.textContent.includes('Simply making 3 addresses rich') === true)
			assert.ok(richHeader)
			assert.equal(String(richHeader.getAttribute('aria-expanded')), 'true')
			assert.ok(findElementByTagAndClass(richHeader, 'div', 'card-header-icon'))
			assert.ok(findElementByTagAndClass(richHeader, 'p', 'card-header-title'))
			await act(async () => {
				await clickElement(richHeader)
			})
			assert.equal(String(richHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(dom.document.body.textContent.includes('Addresses being made rich are'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer rich address sentence handles one entry', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createSerializableRichHomePageUpdate(12, 1, 'Rich tab', 1, richList))
			})

			assert.equal(dom.document.body.textContent.includes('Address being made rich is'), true)
			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute('aria-label') === 'Address being made rich is Treasury One.'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows stack operations without an active simulation address', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createSimulationStackHomePageUpdate(13, 1, 'Stack tab'))
			})

			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent.includes('Import, export, and adjust the simulation stack.'), true)
			assert.equal(dom.document.body.textContent.includes('Loading...'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Export'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Clear stack'), true)
			assert.equal(getButtonByText(dom.document.body, 'Import').getAttribute('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Export').getAttribute('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Clear stack').getAttribute('class')?.includes('is-small') ?? false, false)
			const headerControls = findElementByTagAndClass(dom.document.body, 'nav', 'simulation-stack-page-controls')
			assert.ok(headerControls)
			assert.equal(collectElements(headerControls, 'button').length, 3)
			assert.equal(findElementByTagAndClass(dom.document.body, 'nav', 'simulation-stack-page-actions'), undefined)
			assert.equal(dom.document.body.textContent.includes('Export Simulation Stack'), false)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.textContent.includes('Pending transaction'), true)
			assert.equal(targetRow.textContent.includes('Simulate delay'), false)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer uses the signing Safe as the visualized address in signing mode', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const update = createStackHomePageUpdate(13, 1, 'Safe signing stack', [1n], 1)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, {
						...update,
						data: { ...update.data, makeCurrentAddressRich: true },
					})
			})

			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute('aria-label') === 'Address being made rich is Test Safe.'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer remains a Gnosis Safe stack when the current tab cannot resolve the Safe owner', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const update = createStackHomePageUpdate(13, 1, 'Safe signing stack', [1n], 0)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, {
						...update,
						data: {
							...update.data,
							activeSigningAddressInThisTab: 0x1000000000000000000000000000000000000001n,
							tabState: { ...update.data.tabState, signerConnected: false, signerAccounts: [], activeSigningAddress: undefined },
						},
					})
			})

			assert.equal(dom.document.body.textContent.includes('Gnosis Safe Stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer keeps the page header first when an unexpected error is visible', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const update = createStackHomePageUpdate(13, 1, 'Stack tab')
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, {
						...update,
						data: {
							...update.data,
							latestUnexpectedError: {
								method: 'popup_UnexpectedErrorOccured',
								data: {
									message: 'render failed',
									timestamp: new Date('2024-01-01T00:00:00.000Z'),
									source: 'simulationStack',
									code: 'render_error',
									debugId: undefined,
								},
							},
						},
					})
			})

			const layout = findElementByTagAndClass(dom.document.body, 'div', 'simulation-stack-page')
			assert.ok(layout)
			assert.equal(getFirstElementChild(layout)?.tagName, 'HEADER')
			assert.equal(getFirstElementChild(layout)?.textContent.includes('Gnosis Safe Stack'), true)
			const pageBody = getElementChildren(layout)[1]
			assert.ok(pageBody !== undefined)
			assert.equal(pageBody.tagName, 'DIV')
			assert.equal(hasClass(pageBody, 'simulation-stack-page-body'), true)
			assert.equal(dom.document.body.textContent.includes('An unexpected error occured!'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows rich addresses in simulated stack state', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const richList = [
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury Three'),
			createRichListElement(0x4000000000000000000000000000000000000004n, 'Treasury Four'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(13, 1, 'Stack tab', [1n], 2, richList))
			})

			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent.includes('Addresses being made rich are'), true)
			assert.equal(dom.document.body.textContent.includes('Treasury Three'), true)
			assert.equal(dom.document.body.textContent.includes('Treasury Four'), true)
			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute('aria-label') === 'Addresses being made rich are Treasury Three and Treasury Four.'), true)
			const richHeader = collectElements(dom.document.body, 'header').find((header) => header.textContent.includes('Simply making 2 addresses rich') === true)
			assert.ok(richHeader)
			assert.equal(String(richHeader.getAttribute('aria-expanded')), 'true')

			await act(async () => {
				await clickElement(richHeader)
			})
			assert.equal(String(richHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(dom.document.body.textContent.includes('Addresses being made rich are'), false)
			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer refreshes rich metadata after live simulation updates', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		const serializableSettings = createSerializableSettings()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			await act(() => {
				deliverHomePageUpdate(messaging, createSimulationStackHomePageUpdate(19, 1, 'Stack tab'))
			})
			messaging.sentMessages.splice(0)

			await act(() => {
				deliverPopupMessage(messaging, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation(serializableSettings, [1n], 1)))
			})

			assert.equal(messaging.sentMessages.some((message) => isHomeDataRequest(message, false, false)), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer failure banner stays readable outside blurred simulation content', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createFailedStackHomePageUpdate(16, 1, 'Failed stack tab'))
			})

			const errorMessage = 'Failed to simulate the stack due to error: "execution reverted". Please modify the stack to make it simutable.'
			const errorBanner = collectElements(dom.document.body, 'p').find((element) => element.textContent.includes(errorMessage) === true)
			assert.ok(errorBanner)
			assert.equal(hasAncestorWithClass(errorBanner, 'blur'), false)
			const blurredContent = findElementByTagAndClass(dom.document.body, 'div', 'blur')
			assert.ok(blurredContent)
			assert.equal(blurredContent?.textContent.includes('Pending transaction') ?? false, true)
		} finally {
			dom.restore()
		}
	})
})
