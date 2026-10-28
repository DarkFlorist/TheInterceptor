import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import { ICON_SIGNING } from '../../app/ts/utils/constants.js'
import type { TabState } from '../../app/ts/types/user-interface-types.js'
import { PASSTHROUGH_STATE, toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { ResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, getButtonByAriaLabel, getButtonByText, getHeaderContainingText, hasClass, keyDownElement, waitForRender } from './domQueries.js'
import { createEmptySimulationResults, createHomeParams, createPendingSignedMessageSimulationResults, createPendingSimulationResults, createSafeSimulationResults, createSimulationResults, getAncestor, getButtonInTimePicker, installCloseMock, readHomeSource, SAFE_ADDRESS, SAFE_SIGNER_ADDRESS, safeEntry, safeSignerEntry, getDeliveredMessageWithMethod } from './homePageTestHarness.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('Home popup simulation results and stack actions', () => {
	test('shows a skeleton until initial simulation status is known', async () => {
		const dom = installDomMock()
		const simulationUpdatingState = new Signal<'done' | 'updating' | 'failed' | undefined>(undefined)
		const simulationResultState = new Signal<'done' | 'invalid' | 'corrupted' | undefined>(undefined)
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults: new Signal(PASSTHROUGH_STATE),
					simulationUpdatingState,
					simulationResultState,
				})), dom.document.body)
			})

			const loadingState = [...collectElements(dom.document.body, 'div'), ...collectElements(dom.document.body, 'section')]
				.find((element) => element.getAttribute('aria-label') === 'Loading current simulation state')
			assert.ok(loadingState !== undefined)
			assert.notEqual(collectElements(loadingState, 'div').find((element) => hasClass(element, 'simulation-results-header')), undefined)
			assert.equal(collectElements(dom.document.body, 'svg').find((element) => element.getAttribute('class') === 'spinner'), undefined)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), false)

			await act(() => {
				simulationUpdatingState.value = 'done'
				simulationResultState.value = 'done'
			})

			const resolvedLoadingState = [...collectElements(dom.document.body, 'div'), ...collectElements(dom.document.body, 'section')]
				.find((element) => element.getAttribute('aria-label') === 'Loading current simulation state')
			assert.equal(resolvedLoadingState, undefined)
			assert.notEqual(collectElements(dom.document.body, 'div').find((element) => hasClass(element, 'simulation-results-header')), undefined)
			assert.equal(collectElements(dom.document.body, 'svg').find((element) => element.getAttribute('class') === 'spinner'), undefined)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), true)
		} finally {
			dom.restore()
		}
	})

	test('rerenders to the empty-state dino when simulation results are cleared', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('Simulation Outcome'), true)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), false)

			await act(() => {
				simVisResults.value = toResolvedSimulationResults(createEmptySimulationResults())
			})

			assert.equal(simVisResults.value.kind, 'simulated')
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), true)
			assert.equal(dom.document.body.textContent.includes('Simulation Outcome'), false)
		} finally {
			dom.restore()
		}
	})

	test('shows rich-only simulation state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults,
					numberOfAddressesMadeRich: new Signal(2),
				})), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('opens the simulation stack from the rich-only state card', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults,
					numberOfAddressesMadeRich: new Signal(2),
				})), dom.document.body)
			})

			const richHeader = getHeaderContainingText(dom.document.body, 'Simply making 2 addresses rich')
			assert.equal(richHeader.getAttribute('role'), 'button')
			assert.equal(richHeader.getAttribute('aria-label'), 'Open rich address state in the full simulation stack')

			await act(async () => {
				await clickElement(richHeader)
			})

			assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_openSimulationStack'), { method: 'popup_openSimulationStack' })
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			closeMock.restore()
		}
	})

	test('shows title-only stack cards while keeping per-transaction delay controls', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent.includes('Simulate delay'), true)
			assert.equal(dom.document.body.textContent.includes('Original request'), false)
			assert.equal(dom.document.body.textContent.includes('Transaction Input'), false)
		} finally {
			dom.restore()
		}
	})

		test('opens the simulation stack at a title-only transaction header', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			await act(async () => {
				await clickElement(getHeaderContainingText(dom.document.body, 'Pending transaction'))
			})

			assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_openSimulationStack'), {
				method: 'popup_openSimulationStack',
				data: { type: 'Transaction', transactionIdentifier: '0x1' },
			})
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			closeMock.restore()
			}
		})

		test('opens the simulation stack from a title-only transaction header with Enter', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
			const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
			try {
				await act(() => {
					render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
				})

				const header = getHeaderContainingText(dom.document.body, 'Pending transaction')
				let preventDefaultCalled = false
				await act(async () => {
					await keyDownElement(header, {
						key: 'Enter',
						target: header,
						currentTarget: header,
						preventDefault() {
							preventDefaultCalled = true
						},
					})
				})

				assert.equal(preventDefaultCalled, true)
				assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_openSimulationStack'), {
					method: 'popup_openSimulationStack',
					data: { type: 'Transaction', transactionIdentifier: '0x1' },
				})
				assert.equal(closeMock.closeCount, 1)
			} finally {
				render(undefined, dom.document.body)
				dom.restore()
				closeMock.restore()
			}
		})

		test('opens the simulation stack from a title-only signature header with Space', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
			const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSignedMessageSimulationResults()))
			try {
				await act(() => {
					render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
				})

				const header = getHeaderContainingText(dom.document.body, 'Pending signature')
				let preventDefaultCalled = false
				await act(async () => {
					await keyDownElement(header, {
						key: ' ',
						target: header,
						currentTarget: header,
						preventDefault() {
							preventDefaultCalled = true
						},
					})
				})

				assert.equal(preventDefaultCalled, true)
				assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_openSimulationStack'), {
					method: 'popup_openSimulationStack',
					data: { type: 'Message', messageIdentifier: '0x4d' },
				})
				assert.equal(closeMock.closeCount, 1)
			} finally {
				render(undefined, dom.document.body)
				dom.restore()
				closeMock.restore()
			}
		})

		test('does not open the simulation stack from bubbled remove-button key events', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			const removeButton = getButtonByAriaLabel(dom.document.body, 'remove')
			const header = getAncestor(removeButton, 'header')
			let preventDefaultCalled = false

			await act(async () => {
				await keyDownElement(header, {
					key: 'Enter',
					target: removeButton,
					currentTarget: header,
					preventDefault() {
						preventDefaultCalled = true
					},
				})
			})

			assert.equal(preventDefaultCalled, false)
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_openSimulationStack')), false)

			await act(async () => {
				await clickElement(removeButton)
			})

			assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_removeTransactionOrSignedMessage'), {
				method: 'popup_removeTransactionOrSignedMessage',
				data: { type: 'Transaction', transactionIdentifier: '0x1' },
			})
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_openSimulationStack')), false)
			assert.equal(closeMock.closeCount, 0)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			closeMock.restore()
		}
	})

	test('commits title-only signed-message delay controls with the message identifier', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSignedMessageSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent.includes('Pending signature'), true)
			assert.equal(dom.document.body.textContent.includes('Simulate delay'), true)
			assert.equal(dom.document.body.textContent.includes('Signature request'), false)
			assert.equal(dom.document.body.textContent.includes('Raw request'), false)

			await act(async () => {
				await clickElement(getButtonInTimePicker(dom.document.body, 'Simulate delay', 'For'))
			})
			await act(async () => {
				await clickElement(getButtonInTimePicker(dom.document.body, 'Simulate delay', 'Commit'))
			})

			assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_setTransactionOrMessageBlockTimeManipulator'), {
				method: 'popup_setTransactionOrMessageBlockTimeManipulator',
				data: {
					transactionOrMessageIdentifier: { type: 'Message', messageIdentifier: '0x4d' },
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0xc', deltaUnit: 'Seconds' },
				},
			})
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('opens the simulation stack view from the popup button', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			const viewStackButton = getButtonByText(dom.document.body, 'View & operate stack')
			assert.equal(viewStackButton.getAttribute('aria-label'), 'View and operate the transaction stack in a new tab')
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent.replace(/\s+/g, ' ').trim() === 'Import'), false)
			assert.equal(dom.document.body.textContent.includes('Export Simulation Stack'), false)

			await act(async () => {
				await clickElement(viewStackButton)
			})

			assert.deepStrictEqual(getDeliveredMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_openSimulationStack'), { method: 'popup_openSimulationStack' })
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			closeMock.restore()
		}
	})

	test('places stack operation and clear actions together without a Safe export action', async () => {
		const homeSource = await readHomeSource()
		const headerStart = homeSource.indexOf('function SimulationResultsHeader(')
		const headerEnd = homeSource.indexOf('function PopupVisualisation(', headerStart)
		const headerSource = homeSource.slice(headerStart, headerEnd)
		const viewPosition = headerSource.indexOf('<OpenSimulationStackButtonContent')
		const clearPosition = headerSource.indexOf('<AsyncActionButton')

		assert.notEqual(viewPosition, -1)
		assert.notEqual(clearPosition, -1)
		assert.equal(viewPosition < clearPosition, true)
		assert.equal(headerSource.includes('CopySafeTransactionsButton'), false)
	})

	test('does not expose Gnosis Safe export from the Home results header', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		try {
			await act(async () => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry, safeSignerEntry]),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					simulationMode: new Signal(false),
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
					simVisResults: new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSafeSimulationResults())),
					hasSafeTransactionsToExport: new Signal(true),
				})), dom.document.body)
			})
			await waitForRender(() => dom.document.body.textContent.includes('View & operate stack'), { description: 'the Home results header' })

			assert.equal(dom.document.body.textContent.includes('Copy Gnosis Safe transactions'), false)
			assert.equal(dom.document.body.textContent.includes('View & operate stack'), true)
			assert.equal(dom.document.body.textContent.includes('Clear'), true)
			assert.equal(dom.document.body.textContent.includes('Simulate delay'), false)
			assert.equal(getButtonByText(dom.document.body, 'View & operate stack').parentNode, getButtonByText(dom.document.body, 'Clear').parentNode)
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_requestSafeStackExport')), false)
			assert.equal(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_setTransactionOrMessageBlockTimeManipulator')), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('keeps the configured Safe stack visible when the current tab displays the wallet owner', async () => {
		const dom = installDomMock()
		try {
			await act(async () => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry, safeSignerEntry]),
					activeSigningSafeAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					displayedSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					simulationMode: new Signal(false),
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
					simVisResults: new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSafeSimulationResults())),
					hasSafeTransactionsToExport: new Signal(true),
				})), dom.document.body)
			})
			await waitForRender(() => dom.document.body.textContent.includes('View & operate stack'), { description: 'the Home results header' })

			assert.equal(dom.document.body.textContent.includes('Simulation Results'), true)
			assert.equal(dom.document.body.textContent.includes('View & operate stack'), true)
			assert.equal(dom.document.body.textContent.includes('Copy Gnosis Safe transactions'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
