import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { flushMicrotasks } from '../harness/async.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, findElement, findElementByClass, isDisabled } from './domQueries.js'
import { ASYNC_CHANNEL_CLOSED_ERROR, collectTextSegments, createGnosisSafeMessageFixture, createGovernanceTransactionFixture, createGovernanceVoteInputParameters, createSimulationFailureBroadcast, createSimulationFailureReply, gnosisSignerAddress, loadPopupActionModules, PlaceholderTransactionCard } from './popupAsyncActionTestHarness.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

// The app modules are imported after the browser globals exist, as in the extension; each test then installs its own mock.
installBrowserMock()
const installRuntimeMessaging = createRuntimeMessagingInstaller()

const modulesPromise = loadPopupActionModules()

describe('governance and Gnosis Safe simulation actions wait for background replies', () => {
	test('shows governance simulation progress and a missing-reply error', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		messaging.browserMock.handlers.runtimeMessage = async () => deferredReply.promise

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				transactionCard: PlaceholderTransactionCard,
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const simulateButton = buttons.find((button) => button.textContent.includes('Simulate execution on a passing vote'))
		if (simulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		assert.match(simulateButton.textContent, /Simulating\.\.\./)
		assert.equal(isDisabled(simulateButton), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('Simulating governance execution failed because the background page did not return a reply.'), true)
		assert.equal(dom.document.body.textContent.includes('Simulate execution on a passing vote'), true)
		dom.restore()
	})

	test('matching governance broadcasts clear later missing direct-reply errors', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_simulateGovernanceContractExecution') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				transactionCard: PlaceholderTransactionCard,
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const simulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Simulate execution on a passing vote'))
		if (simulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(simulateButton)
		})

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(5n, 'governance broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('governance broadcast reply'), true)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('governance broadcast reply'), true)
		assert.equal(dom.document.body.textContent.includes('Simulating governance execution failed because the background page did not return a reply.'), false)
		dom.restore()
	})

	test('ignores stale governance simulation replies after the visualizer switches to another transaction', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const staleRequestReply = createSimulationFailureReply(5n, 'stale governance request reply')
		const deferredReply = Promise.withResolvers<typeof staleRequestReply>()
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_simulateGovernanceContractExecution') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				transactionCard: PlaceholderTransactionCard,
				simTx: createGovernanceTransactionFixture(5n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(42n),
			}), dom.document.body)
		})

		const originalSimulateButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Simulate execution on a passing vote'))
		if (originalSimulateButton === undefined) throw new Error('Expected governance simulation button to render')

		await act(async () => {
			await clickElement(originalSimulateButton)
		})

		await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				transactionCard: PlaceholderTransactionCard,
				simTx: createGovernanceTransactionFixture(6n),
				activeAddress: signal(0x2n),
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(43n),
			}), dom.document.body)
		})

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(5n, 'stale governance broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('stale governance broadcast reply'), false)
		assert.equal(dom.document.body.textContent.includes('Refresh'), false)

		await act(async () => {
			deferredReply.resolve(staleRequestReply)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('stale governance request reply'), false)
		assert.equal(dom.document.body.textContent.includes('Refresh'), false)

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(6n, 'current governance broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('current governance broadcast reply'), true)
		dom.restore()
	})

	test('keeps the governance simulation result while re-renders pass equal vote parameters and clears it when they change', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const activeAddress = signal(0x2n)
		// TransactionImportanceBlock identifies the transaction again on every render, so each render passes newly built but equal transaction and vote parameter objects.
		const renderVisualizer = async (proposalId: bigint, hasGovernanceContractAbi = true) => await act(() => {
			render(h(modules.GovernanceVoteVisualizer, {
				transactionCard: PlaceholderTransactionCard,
				simTx: createGovernanceTransactionFixture(5n, { hasGovernanceContractAbi }),
				activeAddress,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
				governanceVoteInputParameters: createGovernanceVoteInputParameters(proposalId),
			}), dom.document.body)
		})
		const hasSimulateButton = () => collectElements(dom.document.body, 'button').some((button) => button.textContent.includes('Simulate execution on a passing vote'))

		await renderVisualizer(42n, false)
		assert.equal(dom.document.body.textContent.includes('Add Abi'), true)
		assert.equal(hasSimulateButton(), false)

		// A re-render that only updates the transaction object, here with the newly added governance contract ABI, shows that transaction.
		await renderVisualizer(42n)
		assert.equal(dom.document.body.textContent.includes('Add Abi'), false)
		assert.equal(hasSimulateButton(), true)

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(5n, 'governance simulation result'))
			await flushMicrotasks()
		})
		assert.equal(dom.document.body.textContent.includes('governance simulation result'), true)

		await renderVisualizer(42n)
		assert.equal(dom.document.body.textContent.includes('governance simulation result'), true)
		assert.equal(hasSimulateButton(), false)

		await renderVisualizer(43n)
		assert.equal(dom.document.body.textContent.includes('governance simulation result'), false)
		assert.equal(dom.document.body.textContent.includes('for proposal: 43'), true)
		assert.equal(hasSimulateButton(), true)

		await act(() => { render(undefined, dom.document.body) })
		dom.restore()
	})

	test('shows Gnosis Safe simulation progress and a missing-reply error', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		let simulationRequestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async () => {
			simulationRequestCount += 1
			return deferredReply.promise
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		const outcomePanel = findElementByClass(dom.document.body, 'safe-outcome-panel')
		assert.ok(outcomePanel !== undefined)
		assert.equal(collectTextSegments(outcomePanel).join(' '), 'Outcome if approved Simulating Gnosis Safe transaction…')

		const loadingState = findElementByClass(dom.document.body, 'safe-outcome-panel__loading')
		assert.equal(loadingState?.getAttribute('role'), 'status')
		assert.equal(loadingState?.getAttribute('aria-label'), 'Simulating Gnosis Safe transaction')
		assert.equal(loadingState?.textContent.trim(), 'Simulating Gnosis Safe transaction…')
		assert.notEqual(findElementByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(simulationRequestCount, 1)

		await act(async () => {
			deferredReply.resolve(undefined)
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('Simulating Gnosis Safe execution failed because the background page did not return a reply.'), true)
		dom.restore()
	})

	test('shows the dapp-originated Gnosis Safe EIP-712 fields and hashes under the signature card extra details', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		messaging.browserMock.handlers.runtimeMessage = async () => undefined
		const gnosisSafeMessage = createGnosisSafeMessageFixture(7n)

		await act(() => {
			render(h(modules.SignatureCard, {
				visualizedPersonalSignRequest: gnosisSafeMessage,
				renameAddressCallBack: () => undefined,
				removeTransactionOrSignedMessage: undefined,
				numberOfUnderTransactions: 0,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})
		const extraDetailsHeader = findElement(dom.document.body, (element) => element.tagName === 'HEADER' && element.textContent.includes('Extra details'))
		if (extraDetailsHeader === undefined) throw new Error('Expected the extra details card')
		assert.equal(dom.document.body.textContent.includes('Domain Hash'), false)

		await act(async () => { await clickElement(extraDetailsHeader) })
		const renderedText = dom.document.body.textContent
		for (const expected of [
			'Gnosis Safe: Safe',
			'Chain: Ethereum Mainnet (1)',
			'To: Recipient',
			'Value (attoeth)0',
			'Operation: 0',
			'Nonce: 1',
			`Domain Hash${ gnosisSafeMessage.domainHash }`,
			`Message Hash${ gnosisSafeMessage.messageHash }`,
			`Gnosis Safe Transaction Hash${ gnosisSafeMessage.safeTxHash }`,
			'Gnosis Safe meta transaction input:',
		]) assert.equal(renderedText.includes(expected), true, `expected "${ expected }" in "${ renderedText }"`)

		await act(() => { render(undefined, dom.document.body) })
		dom.restore()
	})

	test('replaces a completed Gnosis outcome with only a spinner while refreshing', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const initialReply = createSimulationFailureReply(7n, 'Initial Gnosis result')
		const initialDeferredReply = Promise.withResolvers<typeof initialReply>()
		const refreshDeferredReply = Promise.withResolvers<unknown>()
		let simulationRequestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async () => {
			simulationRequestCount += 1
			return simulationRequestCount === 1 ? initialDeferredReply.promise : refreshDeferredReply.promise
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		await act(async () => {
			initialDeferredReply.resolve(initialReply)
			await initialDeferredReply.promise
			await flushMicrotasks()
		})

		const refreshButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Refresh simulation'))
		if (refreshButton === undefined) throw new Error('Expected Gnosis refresh button to render')

		await act(async () => {
			await clickElement(refreshButton)
		})

		assert.equal(findElementByClass(dom.document.body, 'safe-outcome-panel__loading')?.textContent.trim(), 'Simulating Gnosis Safe transaction…')
		assert.notEqual(findElementByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(dom.document.body.textContent.includes('Initial Gnosis result'), false)

		await act(async () => {
			refreshDeferredReply.resolve(undefined)
			await refreshDeferredReply.promise
			await flushMicrotasks()
		})
		dom.restore()
	})

	test('matching Gnosis broadcasts clear later closed-channel direct-reply errors', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_simulateGnosisSafeTransaction') return deferredReply.promise
			return undefined
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(7n, 'Gnosis broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('Gnosis broadcast reply'), true)

		await act(async () => {
			deferredReply.reject(new Error(ASYNC_CHANNEL_CLOSED_ERROR))
			await deferredReply.promise.catch(() => undefined)
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('Gnosis broadcast reply'), true)
		assert.equal(dom.document.body.textContent.includes('Simulating Gnosis Safe execution failed because the background page did not return a reply.'), false)
		dom.restore()
	})

	test('ignores stale Gnosis Safe simulation replies after the visualizer switches to another message', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const staleRequestReply = createSimulationFailureReply(7n, 'stale Gnosis request reply')
		const staleDeferredReply = Promise.withResolvers<typeof staleRequestReply>()
		const currentDeferredReply = Promise.withResolvers<unknown>()
		let simulationRequestCount = 0
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_simulateGnosisSafeTransaction') {
				simulationRequestCount += 1
				return simulationRequestCount === 1 ? staleDeferredReply.promise : currentDeferredReply.promise
			}
			return undefined
		}

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(7n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		await act(() => {
			render(h(modules.GnosisSafeVisualizer, {
				gnosisSafeMessage: createGnosisSafeMessageFixture(8n),
				activeAddress: gnosisSignerAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(7n, 'stale Gnosis broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('stale Gnosis broadcast reply'), false)
		assert.equal(dom.document.body.textContent.includes('Refresh simulation'), false)
		assert.notEqual(findElementByClass(dom.document.body, 'spinner'), undefined)

		await act(async () => {
			staleDeferredReply.resolve(staleRequestReply)
			await staleDeferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('stale Gnosis request reply'), false)
		assert.equal(dom.document.body.textContent.includes('Refresh simulation'), false)
		assert.notEqual(findElementByClass(dom.document.body, 'spinner'), undefined)

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createSimulationFailureBroadcast(8n, 'current Gnosis broadcast reply'))
			await flushMicrotasks()
		})

		assert.equal(dom.document.body.textContent.includes('current Gnosis broadcast reply'), true)

		await act(async () => {
			currentDeferredReply.resolve(undefined)
			await currentDeferredReply.promise
			await flushMicrotasks()
		})
		dom.restore()
	})
})
