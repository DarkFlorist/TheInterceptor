import { test } from 'bun:test'
import * as assert from 'node:assert'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { createDeferredSignal, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { addTransactionToNetworkBStack, assertCommittedNetworkBEffects, containsAddress, createAcceptConfirmation, createApprovedConnection, createApprovedSimulationDapp, createImportRequest, createRecordingServicesOwner, createStackedTransaction, createStorageReadPause, failFirstStorageReadAfterWrite, failNextStorageWrite, failStorageWrites, firstAddress, getConfirmationDialogVisualisations, getSimulatedCallRecipients, getSimulateV1Requests, isInvalidatedSharedVisualisation, isNetworkAStackRecipientLookup, networkA, networkAOnOtherEndpoint, networkB, prepareNetworkARefreshAfterNetworkBVisualisation, reportSimulationConsumer, secondAddress, STACKED_LATER_RECIPIENT, STACKED_ON_A_RECIPIENT, STACKED_ON_B_RECIPIENT, stackImportRequest, website, whenRuntimeMessageSent } from './networkTransitionTestHarness.js'
import { readTestNetworkSnapshot } from './simulationInputTestHelper.js'

test('a simulated transaction confirmed after a network switch is not added to the new network stack', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const accept = async (uniqueRequestIdentifier: { readonly requestId: number, readonly requestSocket: { readonly tabId: number, readonly connectionName: bigint } }) => modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(uniqueRequestIdentifier))
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)

			await accept(pending.uniqueRequestIdentifier)
			const networkBStack = await modules.getInterceptorTransactionStack()
			assert.deepEqual(networkBStack.operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.signedTransaction.to : undefined), [STACKED_ON_B_RECIPIENT])
			const [stillPending] = await modules.getPendingTransactionsAndMessages()
			assert.equal(stillPending?.approvalStatus.status, 'SignerError')
			assert.equal(getReply('eth_sendTransaction', 1), undefined)

			// Back on its own network, the same confirmation joins that network's stack and answers the website.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, activeAddress: firstAddress, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			await accept(pending.uniqueRequestIdentifier)
			const networkAStack = await modules.getInterceptorTransactionStack()
			assert.deepEqual(networkAStack.operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [pending.transactionIdentifier])
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.notEqual(getReply('eth_sendTransaction', 1)?.result, undefined)
		} finally {
			retireAll()
		}
	})

test('a block refresh after a network switch keeps a simulation-mode confirmation on the network it was admitted on', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { owner, retireAll, getInstalled } = createRecordingServicesOwner(networkA)
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			const servicesB = getInstalled()

			// The confirmation window refreshes on every new block of the active network.
			await modules.refreshPopupConfirmTransactionSimulation(await modules.readNetworkSnapshot(owner))
			assert.equal(getSimulateV1Requests(servicesB).length, 0)
			const [afterRefresh] = await modules.getPendingTransactionsAndMessages()
			if (afterRefresh?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			assert.equal(afterRefresh.simulationChainId, networkA.chainId)
			assert.deepEqual(afterRefresh.transactionToSimulate, pending.transactionToSimulate)

			await modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(pending.uniqueRequestIdentifier))
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
			const [stillPending] = await modules.getPendingTransactionsAndMessages()
			assert.equal(stillPending?.approvalStatus.status, 'SignerError')
			assert.equal(getReply('eth_sendTransaction', 1), undefined)
		} finally {
			retireAll()
		}
	})

test('a confirmation metadata refresh shows the stack captured with its settings and services', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const context: PopupMessageDispatcherContext = {
				websiteTabConnections,
				simulationServicesOwner: capturingOwner,
				settings: await modules.getSettings(),
				publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
				simulationAbortController: new AbortController(),
				confirmTransactionAbortController: new AbortController(),
				resetSimulationState: async () => undefined,
			}
			const refresh = dispatchPopupMessage(context, { method: 'popup_refreshConfirmTransactionMetadata' })
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			const simulationsBeforeRefresh = getSimulateV1Requests(servicesA).length
			readPause.release()
			await refresh

			assert.ok(getSimulateV1Requests(servicesA).length > simulationsBeforeRefresh)
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
		} finally {
			readPause.release()
			retireAll()
		}
	})

test.each(['the first storage read after the operation joins the stack', 'the terminal reply write'] as const)('an accepted transaction whose confirmation fails at %s is confirmed once by a retry, with the hash of the stacked transaction', async (failurePoint) => {
		const { modules, websiteTabConnections, sendDappRequest, getReply, getReplies, createPopupContext } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const accept = async (uniqueRequestIdentifier: { readonly requestId: number, readonly requestSocket: { readonly tabId: number, readonly connectionName: bigint } }) => await modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(uniqueRequestIdentifier))
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			const failure = new Error(`Injected failure at ${ failurePoint }`)
			if (failurePoint === 'the terminal reply write') failNextStorageWrite('pendingTerminalReplies', failure)
			else failFirstStorageReadAfterWrite('interceptorTransactionStack', failure)
			// A failure after the append may or may not end this attempt; the retry must finish it either way.
			await accept(pending.uniqueRequestIdentifier).catch((error: unknown) => assert.equal(error, failure))
			// A refresh before the retry would otherwise re-prepare the transaction against a stack that already holds it.
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await accept(pending.uniqueRequestIdentifier)

			const stackedCopies = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pending.transactionIdentifier ? [operation.preSimulationTransaction] : [])
			assert.equal(stackedCopies.length, 1)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.equal(getReplies('eth_sendTransaction', 1).length, 1)
			const repliedHash = getReply('eth_sendTransaction', 1)?.result
			if (typeof repliedHash !== 'string') throw new Error('Expected the transaction hash in the reply')
			assert.equal(BigInt(repliedHash), stackedCopies[0]?.signedTransaction.hash)
		} finally {
			retireAll()
		}
	})

test('an accept that captured another network and finishes after switching back shows the stack only with the installed services', async () => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
			await switchToNetworkB(owner)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			// The accept captures B's settings and services, then waits while the user switches back to A.
			const acceptance = modules.confirmDialog(capturingOwner, websiteTabConnections, await createAcceptConfirmation(pending.uniqueRequestIdentifier))
			await readPause.started
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, activeAddress: firstAddress, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			readPause.release()
			await acceptance

			assert.notEqual(getReply('eth_sendTransaction', 1)?.result, undefined)
			assert.ok(!getSimulatedCallRecipients(servicesB).includes(secondAddress))
			const [servicesA] = installed.slice(-1)
			if (servicesA === undefined) throw new Error('Missing reinstalled network A services')
			assert.ok(getSimulatedCallRecipients(servicesA).includes(secondAddress))
		} finally {
			readPause.release()
			retireAll()
		}
	})

test('a confirmation refresh that finishes after another network published its visualisation shows its own network', async () => {
		const { modules, runtimeMessages, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const getConfirmationDialogVisualisationChains = () => runtimeMessages.flatMap((message) => {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog') return []
			const simulationState = parsed.value.data.visualizedSimulatorState.simulationState
			// The dialog message nests its visualisation in serialized form, so normalise the chain id.
			return [simulationState.kind === 'simulated' ? BigInt(simulationState.value.rpcNetwork.chainId) : undefined]
		})
		try {
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const refresh = dispatchPopupMessage(await createPopupContext(capturingOwner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await readPause.started
			// With the window open, the switch publishes B's visualisation just before the A refresh resumes.
			await switchToNetworkB(owner)
			const dialogUpdatesBeforeRefresh = getConfirmationDialogVisualisationChains().length
			readPause.release()
			await refresh

			assert.deepEqual(getConfirmationDialogVisualisationChains().slice(dialogUpdatesBeforeRefresh), [networkA.chainId])
		} finally {
			readPause.release()
			retireAll()
		}
	})

test('a typed data message whose domain names another chain is accepted on the network it was admitted on', async () => {
		const { modules, websiteTabConnections, sendDappRequest, getReply } = await createApprovedSimulationDapp()
		await modules.setRpcList([networkA, networkB])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkB.chainId) },
			message: { contents: 'Hello' },
		}
		try {
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated message')
			// The confirmation shows the domain's chain, while the request was admitted on A.
			assert.equal(pending.visualizedPersonalSignRequest.rpcNetwork.chainId, networkB.chainId)
			await modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(pending.uniqueRequestIdentifier))

			assert.notEqual(getReply('eth_signTypedData_v4', 1)?.result, undefined)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations.map((operation) => operation.type), ['Message'])
		} finally {
			retireAll()
		}
	})

test('a signing-mode message refreshed after a network switch is described on the active chain and warns that it is for another chain', async () => {
		const { modules, runtimeMessages, sendDappRequest, socket } = await createApprovedSimulationDapp({ signerConfirmed: true })
		await modules.setRpcList([networkA, networkB])
		await modules.changeSimulationMode({ simulationMode: false, activeSigningAddress: firstAddress, rpcNetwork: networkA })
		await modules.setUseSignersAddressAsActiveAddress(true, firstAddress)
		await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [firstAddress], activeSigningAddress: firstAddress }))
		const { owner, retireAll, getInstalled } = createRecordingServicesOwner(networkA)
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkA.chainId) },
			message: { contents: 'Hello' },
		}
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		try {
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] })
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated message')
			assert.equal(pending.simulationMode, false)
			assert.equal(pending.visualizedPersonalSignRequest.quarantine, false)

			// The wallet follows the switch, so it would sign while chain B is active.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			const servicesB = getInstalled()
			const messagesBefore = runtimeMessages.length
			await modules.refreshPopupConfirmTransactionMetadata(await modules.readNetworkSnapshot(owner), undefined)

			const refreshedMessages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				if (!parsed.success || parsed.value.method !== 'popup_update_confirm_transaction_dialog_pending_transactions') return []
				const [first] = parsed.value.data.pendingTransactionAndSignableMessages
				return first?.type === 'SignableMessage' && first.transactionOrMessageCreationStatus === 'Simulated' ? [first.visualizedPersonalSignRequest] : []
			})
			assert.equal(refreshedMessages.length, 1)
			assert.equal(refreshedMessages[0]?.quarantine, true)
			assert.match(refreshedMessages[0]?.quarantineReasons.join(' ') ?? '', /different chain/u)
		} finally {
			retireAll()
		}
	})

test.each(['switch', 'import'] as const)('a signing-mode %s to another chain drops the simulation stack before simulation is enabled there', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			if (kind === 'switch') await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			else await modules.importSettings(owner, new Map(), await createImportRequest(modules.exportSettingsAndAddressBook, networkB, false))
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, promptForAccessesIfNeeded: false })

			const snapshot = await modules.readNetworkSnapshot(owner)
			assert.equal(snapshot.settings.simulationMode, true)
			assert.equal(snapshot.settings.activeRpcNetwork.chainId, networkB.chainId)
			assert.deepEqual(snapshot.simulation.interceptorTransactionStack.operations, [])
			assert.ok(!containsAddress(snapshot.simulation.simulationStateInput, STACKED_ON_A_RECIPIENT))
		} finally {
			retireAll()
		}
	})

test('a confirmation refresh shows the visualisation of its captured stack, and leaves the shared visualisation on a newer stack published meanwhile', async () => {
		const { modules, runtimeMessages, sendDappRequest, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const getMessages = (method: string) => runtimeMessages.filter((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === method)
		const getDialogUpdates = () => getMessages('popup_update_confirm_transaction_dialog')
		const getSharedVisualisationBroadcasts = () => getMessages('popup_simulation_state_changed')
		try {
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			const refresh = dispatchPopupMessage(await createPopupContext(capturingOwner), { method: 'popup_refreshConfirmTransactionDialogSimulation' })
			await readPause.started
			// Another operation changes the same chain's stack and publishes its visualisation while the refresh waits.
			await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, createStackedTransaction(5n, networkA.chainId, STACKED_LATER_RECIPIENT)] }))
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const newerVisualisation = await modules.getPopupVisualisationState()
			assert.ok(containsAddress(newerVisualisation, STACKED_LATER_RECIPIENT))
			const dialogUpdatesBeforeRefresh = getDialogUpdates().length
			const broadcastsBeforeRefresh = getSharedVisualisationBroadcasts().length
			readPause.release()
			await refresh

			const refreshUpdates = getDialogUpdates().slice(dialogUpdatesBeforeRefresh)
			assert.ok(refreshUpdates.length > 0)
			for (const update of refreshUpdates) {
				assert.ok(containsAddress(update, STACKED_ON_A_RECIPIENT))
				assert.ok(!containsAddress(update, STACKED_LATER_RECIPIENT))
			}
			// The confirmation's older stack neither replaces nor is broadcast as the shared visualisation.
			assert.deepEqual(await modules.getPopupVisualisationState(), newerVisualisation)
			assert.deepEqual(getSharedVisualisationBroadcasts().slice(broadcastsBeforeRefresh), [])
		} finally {
			readPause.release()
			retireAll()
		}
	})

test.each(['dialog simulation', 'metadata'] as const)('a confirmation %s refresh whose visualisation fails to fetch shows no visualisation instead of the one another network stored', async (path) => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			servicesA.interceptRequests(async (request) => {
				if (isNetworkAStackRecipientLookup(request)) throw new Error('Failed to fetch')
			})
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation[path]()

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.deepEqual([visualisation.simulationUpdatingState, visualisation.simulationResultState], ['failed', 'invalid'])
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

test('a confirmation dialog simulation refresh with no simulation consumer open computes the visualisation of its own snapshot', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			// Only the confirmation window is open, and it does not answer the probe for the main popup.
			reportSimulationConsumer(false)
			const simulationsOnA = getSimulateV1Requests(servicesA).length
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation['dialog simulation']()

			assert.ok(getSimulateV1Requests(servicesA).length > simulationsOnA)
			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

test('a confirmation metadata refresh that another network refresh supersedes while it computes still shows its own visualisation', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, servicesA, refreshConfirmation, refreshNetworkB } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			const lookupStarted = createDeferredSignal()
			const releaseLookup = createDeferredSignal()
			servicesA.interceptRequests(async (request) => {
				if (!isNetworkAStackRecipientLookup(request)) return
				lookupStarted.resolve()
				await releaseLookup.promise
			})
			const invalidationPublished = whenRuntimeMessageSent(isInvalidatedSharedVisualisation)
			const messagesBeforeRefresh = runtimeMessages.length
			const refresh = refreshConfirmation.metadata()
			await lookupStarted.promise
			// B's refresh invalidates the shared visualisation under a newer id in the serialized section, so it does so once A's computation has finished.
			const superseding = refreshNetworkB()
			releaseLookup.resolve()
			await Promise.all([refresh, superseding, invalidationPublished])

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

test('a confirmation metadata refresh shows its own visualisation even when another network publishes one before the refresh returns', async () => {
		const recordingOwner = createRecordingServicesOwner(networkA)
		try {
			const { runtimeMessages, refreshConfirmation, refreshNetworkB } = await prepareNetworkARefreshAfterNetworkBVisualisation(recordingOwner)
			const { computeSnapshotVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
			const messagesBeforeRefresh = runtimeMessages.length
			await refreshConfirmation.metadata({
				compute: async (...parameters: Parameters<typeof computeSnapshotVisualisation>) => {
					const visualisation = await computeSnapshotVisualisation(...parameters)
					// The metadata refresh cannot be cancelled, so B's refresh runs once A's has computed and before A's caller has returned.
					await refreshNetworkB()
					return visualisation
				},
			})

			const visualisations = await getConfirmationDialogVisualisations(runtimeMessages, messagesBeforeRefresh)
			assert.equal(visualisations.length, 1)
			for (const visualisation of visualisations) {
				assert.ok(!containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
				assert.ok(containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			}
		} finally {
			recordingOwner.retireAll()
		}
	})

test.each(['simulated', 'failed to simulate'] as const)('a stack visualisation of A that is %s and finishes after a switch to B describes its messages and transactions on A', async (outcome) => {
		const { modules, websiteTabConnections, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp()
		const { getUpdatedSimulationState, visualizeSimulatorState } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.setRpcList([networkA, networkB])
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		// On A the typed data domain names the active chain, so the message needs no chain quarantine there.
		const typedData = {
			types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
			primaryType: 'Mail',
			domain: { name: 'Mail', chainId: Number(networkA.chainId) },
			message: { contents: 'Hello' },
		}
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await sendDappRequest(owner, { method: 'eth_signTypedData_v4', params: [addressString(firstAddress), JSON.stringify(typedData)] }, 1)
			await sendDappRequest(owner, { method: 'personal_sign', params: ['0x68656c6c6f', addressString(firstAddress)] }, 2)
			for (const pending of await modules.getPendingTransactionsAndMessages()) {
				await modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(pending.uniqueRequestIdentifier))
			}
			await modules.updateInterceptorTransactionStack((stack) => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT), ...stack.operations] }))
			const { simulation } = await modules.readNetworkSnapshot(owner)
			if (outcome === 'failed to simulate') servicesA.interceptRequests(async (request) => {
				if (request.method === 'eth_simulateV1') throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Injected simulation failure' } })
			})
			const simulationState = await getUpdatedSimulationState(simulation)
			if (simulationState.kind !== 'simulated') throw new Error('Expected A to be simulated')
			assert.equal(simulationState.value.success, outcome === 'simulated')
			await switchToNetworkB(owner)
			const visualised = await visualizeSimulatorState(simulationState.value, servicesA.ethereum, servicesA.tokenPriceService, undefined)

			const visualizedBlocks = visualised.visualizedSimulationState.visualizedBlocks
			const messages = visualizedBlocks.flatMap((block) => block.visualizedPersonalSignRequests)
			assert.deepEqual(messages.map((message) => [message.method, message.rpcNetwork.chainId, message.quarantine]), [['eth_signTypedData_v4', networkA.chainId, false], ['personal_sign', networkA.chainId, false]])
			const transactions = visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions)
			assert.deepEqual(transactions.map((transaction) => transaction.transaction.rpcNetwork.chainId), [networkA.chainId])
		} finally {
			retireAll()
		}
	})

test.each(['transaction', 'failed transaction', 'message'] as const)('a confirmation metadata refresh after a switch does not enrich the pending %s of the previous network', async (kind) => {
		const { modules, runtimeMessages, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			if (kind !== 'message') await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
			else await sendDappRequest(owner, { method: 'personal_sign', params: ['0x68656c6c6f', addressString(firstAddress)] })
			if (kind === 'failed transaction') {
				const [request] = await modules.getPendingTransactionsAndMessages()
				if (request === undefined) throw new Error('Expected the admitted request')
				await modules.updatePendingTransactionOrMessage(request.uniqueRequestIdentifier, async (current) => {
					if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated transaction')
					const data = current.popupVisualisation.data
					return { ...current, popupVisualisation: { statusCode: 'failed', data: { ...data, error: { code: -32000, message: 'Simulation unavailable', decodedErrorMessage: 'Simulation unavailable' }, simulationState: { blockNumber: data.simulationState.blockNumber, simulationConductedTimestamp: data.simulationState.simulationConductedTimestamp } } } }
				})
			}
			await switchToNetworkB(owner)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			const pendingBeforeRefresh = await modules.getPendingTransactionsAndMessages()
			const [pending] = pendingBeforeRefresh
			if (pending?.transactionOrMessageCreationStatus !== 'Simulated' && pending?.transactionOrMessageCreationStatus !== 'FailedToSimulate') throw new Error('Expected a request simulated on A')
			if (pending.type === 'Transaction') {
				if (pending.popupVisualisation.statusCode === 'success') assert.equal(pending.popupVisualisation.data.simulationState.rpcNetwork.chainId, networkA.chainId)
				else assert.equal(pending.simulationChainId, networkA.chainId)
			} else {
				assert.equal(pending.simulationChainId, networkA.chainId)
			}
			const requestsBeforeRefresh = servicesB.requests.length
			const messagesBeforeRefresh = runtimeMessages.length
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_refreshConfirmTransactionMetadata' })

			// B's services looked nothing up for A's request, and nothing mixing the two networks was stored or sent.
			assert.deepEqual(servicesB.requests.slice(requestsBeforeRefresh).filter((request) => request.method === 'eth_getCode'), [])
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), pendingBeforeRefresh)
			assert.ok(!runtimeMessages.slice(messagesBeforeRefresh).some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'))
		} finally {
			retireAll()
		}
	})

test('a confirmation window opened after a switch bootstraps without the previous network visualisation', async () => {
		const { modules, sendDappRequest, switchToNetworkB, createPopupContext } = await createApprovedSimulationDapp()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { updatePopupVisualisationState } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			// A's visualisation is cached, and with no consumer open the switch leaves it in place.
			await updatePopupVisualisationState(servicesA.ethereum, servicesA.tokenPriceService, undefined, true)
			assert.ok(containsAddress(await modules.getPopupVisualisationState(), STACKED_ON_A_RECIPIENT))
			await switchToNetworkB(owner)
			assert.ok(containsAddress(await modules.getPopupVisualisationState(), STACKED_ON_A_RECIPIENT))
			await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(secondAddress), to: addressString(firstAddress), value: '0x0', data: '0x' }] })

			const reply = await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_readyAndListening', data: { page: 'confirmTransaction' } })
			if (reply === undefined || !('method' in reply) || reply.method !== 'popup_readyAndListening') throw new Error('Expected a confirmation bootstrap')
			const visualisation = reply.data.confirmTransactionBootstrap?.visualizedSimulatorState
			assert.ok(!containsAddress(visualisation, STACKED_ON_A_RECIPIENT))
			// The switch cleared the stack, so B's own visualisation is its defined empty state.
			if (visualisation?.simulationState.kind !== 'simulated') throw new Error('Expected B to be simulated')
			assert.equal(visualisation.simulationState.value.rpcNetwork.chainId, networkB.chainId)
		} finally {
			retireAll()
		}
	})

test.each(['switch', 'import'] as const)('a %s whose stack clearing write fails once still clears the stack before the lock is released', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
		const commitNetworkB = async () => kind === 'switch'
			? await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			: await modules.importSettings(owner, websiteTabConnections, importRequest)
		try {
			const failure = new Error('Injected stack clearing failure')
			failStorageWrites('interceptorTransactionStack', 1, failure)
			if (kind === 'switch') await assert.rejects(commitNetworkB(), (error) => error === failure)
			else assert.deepEqual(await commitNetworkB(), { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: failure.message } })
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await commitNetworkB()
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
		} finally {
			retireAll()
		}
	})

test.each([2, 3])('a switch whose stack clearing write fails %d times is completed by a later snapshot read before it admits the new network', async (failures) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const failure = new Error('Injected stack clearing failure')
			failStorageWrites('interceptorTransactionStack', failures, failure)
			await assert.rejects(modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), (error) => error === failure)
			// The in-lock retry failed too: A's stack is still stored and websites have not been told about B yet.
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
			assert.deepEqual(getChainChangedResults(), [])
			// While the repair keeps failing, the uncleared stack of A is not admitted as B's: the read still serves B's settings and services, and its simulation names the unfinished network change rather than reporting the bare write failure as its own.
			if (failures === 3) {
				const network = await modules.readNetworkSnapshot(owner)
				const { settings, simulation } = network
				const services = network.services
				assert.equal(settings.activeRpcNetwork.chainId, networkB.chainId)
				assert.equal(services.ethereum.getRpcEntry().chainId, networkB.chainId)
				assert.equal(simulation.kind, 'unavailable')
				assert.ok(simulation.kind === 'unavailable' && simulation.error instanceof Error && simulation.error.message.startsWith('An earlier network change committed its settings but could not finish applying them') && simulation.error.message.endsWith(failure.message))
			}
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
		} finally {
			retireAll()
		}
	})

test.each(['interceptorTransactionStack', 'simulationStackChainId'])('a restarted background retries interrupted chain cleanup when writing %s fails', async (failedKey) => {
		installBrowserMock()
		const modules = await loadModules()
		const { browserStorageLocalSet, browserStorageLocalGet } = await import('../../app/ts/utils/storageUtils.js')
		// Recreate only durable state, with no in-memory unfinished-transition callback: settings committed B, but the stack still belongs to A.
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkB })
		await browserStorageLocalSet({ simulationStackChainId: networkA.chainId })
		await modules.updateTransactionState(() => ({
			interceptorTransactionStack: { operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] },
			safeTransactionStacks: [{ chainId: networkA.chainId, safeAddress: firstAddress, safeVersion: '1.4.1', baseNonce: 0n, threshold: 1n, transactions: [] }],
		}))
		const safeStacks = await modules.getSafeTransactionStacks()
		// Startup recreates services for the committed network, even though its stack cleanup was interrupted.
		const { owner, retireAll } = createRecordingServicesOwner(networkB)
		try {
			failNextStorageWrite(failedKey, new Error('Interrupted cleanup'))
			const failedRead = await modules.readNetworkSnapshot(owner)
			assert.equal(failedRead.settings.activeRpcNetwork.chainId, networkB.chainId)
			assert.equal(failedRead.simulation.kind, 'unavailable')
			assert.equal((await browserStorageLocalGet('simulationStackChainId')).simulationStackChainId, networkA.chainId)
			const repaired = await modules.readNetworkSnapshot(owner)
			assert.equal(repaired.simulation.kind, 'loaded')
			if (repaired.simulation.kind !== 'loaded') throw new Error('Expected repaired simulation')
			assert.deepEqual(repaired.simulation.interceptorTransactionStack.operations, [])
			assert.equal((await browserStorageLocalGet('simulationStackChainId')).simulationStackChainId, networkB.chainId)
			assert.deepEqual(await modules.getSafeTransactionStacks(), safeStacks)
			// A subsequent read must not clear operations added after recovery.
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(2n, networkB.chainId, STACKED_ON_B_RECIPIENT)] }))
			await modules.readNetworkSnapshot(owner)
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
		} finally {
			retireAll()
		}
	})

test.each([undefined, networkA.chainId])('a restarted background preserves its current stack with chain identity %s', async (simulationStackChainId) => {
		installBrowserMock()
		const modules = await loadModules()
		const { browserStorageLocalSet, browserStorageLocalGet } = await import('../../app/ts/utils/storageUtils.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkAOnOtherEndpoint })
		if (simulationStackChainId !== undefined) await browserStorageLocalSet({ simulationStackChainId })
		const operations = [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)]
		await modules.updateInterceptorTransactionStack(() => ({ operations }))
		const { owner, retireAll } = createRecordingServicesOwner(networkAOnOtherEndpoint)
		try {
			const read = await modules.readNetworkSnapshot(owner)
			assert.equal(read.simulation.kind, 'loaded')
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, operations)
			assert.equal((await browserStorageLocalGet('simulationStackChainId')).simulationStackChainId, networkA.chainId)
		} finally {
			retireAll()
		}
	})

test('a gas edit admitted with unavailable restart cleanup cannot write even after cleanup recovers', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkB })
		await browserStorageLocalSet({ simulationStackChainId: networkA.chainId })
		const operations = [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)]
		await modules.updateInterceptorTransactionStack(() => ({ operations }))
		const { owner, retireAll } = createRecordingServicesOwner(networkB)
		try {
			failNextStorageWrite('interceptorTransactionStack', new Error('Restart cleanup is unavailable'))
			const admitted = await modules.readNetworkSnapshot(owner)
			assert.equal(admitted.simulation.kind, 'unavailable')
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'loaded')
			const recoveredOperations = [createStackedTransaction(1n, networkB.chainId, STACKED_ON_A_RECIPIENT)]
			await modules.updateInterceptorTransactionStack(() => ({ operations: recoveredOperations }))
			await assert.rejects(modules.forceSetGasLimitForTransaction(admitted, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: 1n, gasLimit: 25_000n } }), /Restart cleanup is unavailable/u)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, recoveredOperations)
		} finally {
			await modules.readNetworkSnapshot(owner)
			retireAll()
		}
	})

test.each(['import', 'delay', 'gas', 'reset', 'remove'])('%s stack writes finish before a waiting network switch can commit', async (mutation) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const admitted = await modules.readNetworkSnapshot(owner)
		const writeStarted = createDeferredSignal()
		const releaseWrite = createDeferredSignal()
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		let armed = true
		Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
			if (armed && 'interceptorTransactionStack' in items) {
				armed = false
				writeStarted.resolve()
				await releaseWrite.promise
			}
			await originalSet(items)
		} })
		const mutate = async () => {
			switch (mutation) {
				case 'import': return await modules.importSimulationStack(admitted, stackImportRequest)
				case 'delay': return await modules.setTransactionOrMessageBlockTimeManipulator(admitted, { method: 'popup_setTransactionOrMessageBlockTimeManipulator', data: { transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n }, blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 15n, deltaUnit: 'Seconds' } } })
				case 'gas': return await modules.forceSetGasLimitForTransaction(admitted, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: 1n, gasLimit: 25_000n } })
				case 'reset': return await modules.resetSimulationStateFromConfig(owner)
				case 'remove': return await modules.removeTransactionOrSignedMessage(admitted, { method: 'popup_removeTransactionOrSignedMessage', data: { type: 'Transaction', transactionIdentifier: 1n } })
				default: throw new Error('Unexpected mutation')
			}
		}
		const writing = mutate()
		let switching: Promise<unknown> | undefined
		try {
			await writeStarted.promise
			switching = modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkA.chainId)
			releaseWrite.resolve()
			await Promise.all([writing, switching])
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkB.chainId)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
		} finally {
			releaseWrite.resolve()
			await Promise.allSettled([writing, switching])
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
			retireAll()
		}
	})

test.each([false, true])('an import paused during preparation cannot append after a network switch (switchBack=%s)', async (switchBack) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const preparing = createDeferredSignal()
		const releasePreparation = createDeferredSignal()
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		let held = false
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys: Parameters<typeof originalGet>[0]) => {
			const result = await originalGet(keys)
			if (!held && keys === 'websiteAccess') {
				held = true
				preparing.resolve()
				await releasePreparation.promise
			}
			return result
		} })
		const { ethereum, tokenPriceService } = owner.getCurrent()
		const importing = modules.importSimulationStack(await readTestNetworkSnapshot({ ethereum, tokenPriceService }), stackImportRequest)
		try {
			await preparing.promise
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			if (switchBack) await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			releasePreparation.resolve()
			const reply = await importing
			assert.equal(reply.ok, false)
			if (reply.ok) throw new Error('Expected stale import to fail')
			assert.match(reply.message, /active network or stack selection changed/u)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
		} finally {
			releasePreparation.resolve()
			await importing
			Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet })
			retireAll()
		}
	})
