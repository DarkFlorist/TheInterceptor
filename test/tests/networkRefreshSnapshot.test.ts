import { test } from 'bun:test'
import * as assert from 'node:assert'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'
import { createDeferredSignal, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { addTransactionToNetworkBStack, countPopupVisualisationWrites, createAcceptConfirmation, createApprovedConnection, createApprovedSimulationDapp, createRecordingServicesOwner, createStackedTransaction, firstAddress, getBroadcastSimulatedVisualisations, getSimulatedCallRecipients, getSimulateV1Requests, networkA, networkAOnOtherEndpoint, networkB, pauseAfterActiveNetworkWrite, pauseNextStorageReadOf, queueBlockedLargeStateReadAfterNextVisualisationRead, reportSimulationConsumer, secondAddress, signerOnlyB, STACKED_ON_A_RECIPIENT, STACKED_ON_B_RECIPIENT, subscribeDappToNewBlocks, websiteOrigin, whenRuntimeMessageSent, whenStorageReadsReturned } from './networkTransitionTestHarness.js'

test('a popup refresh that still holds the previous network services neither simulates the new network stack on them nor replaces its visualisation', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const visualisationOfB = await modules.getPopupVisualisationState()
			const simulationsOnA = getSimulateV1Requests(servicesA).length

			// A popup handler captured A's services just before the switch and refreshes with the settings stored now.
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })

			assert.equal(getSimulateV1Requests(servicesA).length, simulationsOnA)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisationOfB)
		} finally {
			retireAll()
		}
	})

test('a home data refresh that a network switch interrupts sends a home page of the new network only, built and woken on its client', async () => {
		const { modules, runtimeMessages, websiteTabConnections } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { updateTransactionState } = await import('../../app/ts/background/storageVariables.js')
		const { createSafeTx } = await import('../../app/ts/safe/safeCore.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		// A Safe stack on A's chain: a home page built with A's client reports it as exportable, one built with B's does not.
		await updateTransactionState((previousState) => ({
			...previousState,
			safeTransactionStacks: [{
				chainId: networkA.chainId,
				safeAddress: firstAddress,
				safeVersion: '1.4.1',
				baseNonce: 0n,
				threshold: 1n,
				transactions: [{
					safeTx: createSafeTx(networkA.chainId, firstAddress, { to: secondAddress, value: 0n, input: new Uint8Array() }, 0n),
					safeTxHash: 0n,
					created: new Date('2024-01-01T00:00:00.000Z'),
					websiteOrigin,
					transactionIdentifier: 1n,
					signatures: [],
				}],
			}],
		}))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		servicesA.interceptRequests(async () => {
			servicesA.interceptRequests(undefined)
			requestOnAStarted.resolve()
			await releaseRequestOnA.promise
		})
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			const messagesBefore = runtimeMessages.length
			const refresh = refreshHomeData(owner, websiteTabConnections, false, noopPublishRpcConnectionStatus)
			await Promise.race([
				requestOnAStarted.promise,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The refresh sent no request to network A')), 1000) }),
			])
			// The switch commits B and announces its chain while A's request is held; its own popup refresh then queues behind the held refresh.
			const chainAnnounced = whenRuntimeMessageSent((message) => isRecord(message) && message.method === 'popup_chain_update')
			const switching = modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await chainAnnounced
			// B's stack gains a transaction before A's refresh resumes, so a refresh that publishes for A afterwards would show B's stack or a stale network.
			await addTransactionToNetworkBStack(modules)
			const messagesBeforeResume = runtimeMessages.length
			releaseRequestOnA.resolve()
			await Promise.all([switching, refresh])
			assert.equal(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT), false)
			for (const visualisation of await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume))) assert.equal(visualisation.rpcNetwork.chainId, networkB.chainId)

			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) {
				assert.equal(homePage.settings.activeRpcNetwork.chainId, networkB.chainId)
				assert.equal(homePage.hasSafeTransactionsToExport, false)
			}
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), networkB)
			assert.equal(getInstalled().ethereum.isBlockPolling(), true)
			assert.equal(servicesA.ethereum.isBlockPolling(), false)
		} finally {
			clearTimeout(deadline)
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

test('a home data refresh that a same-network stack change interrupts leaves the shared visualisation on the changed stack', async () => {
		const { modules, runtimeMessages, websiteTabConnections, sendDappRequest } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// The stored visualisation simulates the stack, so the refresh's metadata update looks up its addresses.
		await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
		await sendDappRequest(owner, { method: 'eth_sendTransaction', params: [{ from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }] })
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending?.type !== 'Transaction') throw new Error('Expected a pending transaction')
		const countStackedTransactions = (visualisation: { readonly simulationStateInput: readonly { readonly transactions: readonly unknown[] }[] }) => visualisation.simulationStateInput.reduce((count, block) => count + block.transactions.length, 0)
		const acceptSimulationStarted = createDeferredSignal()
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			// The refresh reads its snapshot of the one-transaction stack, then pauses in its metadata update while it looks up the stored visualisation's addresses.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const refresh = refreshHomeData(owner, websiteTabConnections, false, noopPublishRpcConnectionStatus)
			await Promise.race([
				addressBookRead.started,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The metadata update read no address book entries')), 1000) }),
			])
			// Accepting the request appends it to the same network's stack, then refreshes the shared visualisation from that stack; no network change commits, so the generation stays the same.
			const acceptRefreshProbed = whenRuntimeMessageSent((message) => isRecord(message) && message.method === 'popup_isSimulationVisualizerOpen')
			const acceptance = modules.confirmDialog(owner, websiteTabConnections, await createAcceptConfirmation(pending.uniqueRequestIdentifier))
			await acceptRefreshProbed
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 2)
			servicesA.interceptRequests(async (request) => {
				if (request.method !== 'eth_simulateV1') return
				servicesA.interceptRequests(undefined)
				acceptSimulationStarted.resolve()
			})
			await acceptSimulationStarted.promise
			const messagesBeforeResume = runtimeMessages.length
			addressBookRead.release()
			await Promise.all([refresh, acceptance])

			const stored = await modules.getPopupVisualisationState()
			if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated shared visualisation')
			assert.equal(countStackedTransactions(stored.simulationState.value), 2)
			const lastBroadcast = (await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume))).at(-1)
			if (lastBroadcast === undefined) throw new Error('Expected a broadcast shared visualisation')
			assert.equal(countStackedTransactions(lastBroadcast), 2)
		} finally {
			clearTimeout(deadline)
			addressBookRead?.release()
			retireAll()
		}
	})

test('a shared visualisation refresh that a switch to another network and back interrupts neither simulates nor publishes for the replaced client', async () => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		servicesA.interceptRequests(async () => {
			servicesA.interceptRequests(undefined)
			requestOnAStarted.resolve()
			await releaseRequestOnA.promise
		})
		try {
			// Like a block update, the refresh reads its own snapshot of A, then waits for A's client.
			const refresh = updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService)
			await requestOnAStarted.promise
			// The switches' own refreshes skip the closed popup, so only the interrupted refresh could publish afterwards.
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			await addTransactionToNetworkBStack(modules)
			// Returning to A's endpoint installs another client and clears B's stack; the endpoint alone no longer tells the snapshots apart.
			await switchToNetwork(networkA)
			const messagesBeforeResume = runtimeMessages.length
			const storedBeforeResume = await modules.getPopupVisualisationState()
			releaseRequestOnA.resolve()
			await refresh

			assert.equal(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT), false)
			assert.deepEqual(await getBroadcastSimulatedVisualisations(runtimeMessages.slice(messagesBeforeResume)), [])
			assert.deepEqual(await modules.getPopupVisualisationState(), storedBeforeResume)
		} finally {
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

test('an invalidating refresh that a switch interrupts before it invalidates leaves the new network completed visualisation untouched', async () => {
		const { modules, runtimeMessages, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		const requestOnAStarted = createDeferredSignal()
		const releaseRequestOnA = createDeferredSignal()
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			// The next refresh of A pauses on A's client while it compares the stored result with the latest block, before it cancels or invalidates anything.
			servicesA.interceptRequests(async (request) => {
				if (request.method !== 'eth_blockNumber') return
				servicesA.interceptRequests(undefined)
				requestOnAStarted.resolve()
				await releaseRequestOnA.promise
			})
			const refresh = updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true, skipIfUnchanged: true })
			await requestOnAStarted.promise
			await switchToNetworkB(owner)
			const servicesB = getInstalled()
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const completedOnB = await modules.getPopupVisualisationState()
			assert.equal(completedOnB.simulationUpdatingState, 'done')
			const messagesBeforeResume = runtimeMessages.length
			releaseRequestOnA.resolve()
			await refresh

			assert.deepEqual(await modules.getPopupVisualisationState(), completedOnB)
			const stateChanges = runtimeMessages.slice(messagesBeforeResume).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			releaseRequestOnA.resolve()
			retireAll()
		}
	})

test('a metadata refresh with the previous network client leaves a visualisation of the new network untouched', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		try {
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const servicesB = getInstalled()
			await updatePopupVisualisationIfNeeded(servicesB.ethereum, servicesB.tokenPriceService, { invalidateOldState: true })
			const visualisationOfB = await modules.getPopupVisualisationState()
			if (visualisationOfB.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation of B')
			const requestsToABefore = servicesA.requests.length
			// A current snapshot, so only the stored visualisation's network tells this client apart.
			const { simulation } = await modules.readNetworkSnapshot(owner)

			await updateSimulationMetadata(simulation, undefined)

			assert.equal(servicesA.requests.length, requestsToABefore)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisationOfB)
		} finally {
			retireAll()
		}
	})

test.each(['to B', 'to B and back to A'] as const)('a metadata refresh of A that a switch %s interrupts writes nothing to the stored visualisation', async (switches) => {
		const { modules } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const { simulation } = await modules.readNetworkSnapshot(owner)
			// The metadata refresh pauses while it looks up its addresses in the address book.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const metadata = updateSimulationMetadata(simulation, undefined)
			await Promise.race([
				addressBookRead.started,
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The metadata refresh read no address book entries')), 1000) }),
			])
			// With the popup closed the switches write no visualisation of their own, so any write after A resumes would be A's.
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			if (switches === 'to B and back to A') await switchToNetwork(networkA)
			const getWrites = countPopupVisualisationWrites()
			addressBookRead.release()
			await metadata

			assert.equal(getWrites(), 0)
		} finally {
			clearTimeout(deadline)
			addressBookRead?.release()
			retireAll()
		}
	})

test('a home data refresh that sees a signer-only network between two selections of A, which keep A\'s client, sends only a home page of A', async () => {
		const { modules, runtimeMessages, websiteTabConnections } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { refreshHomeData } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { setFixedMakeMeRichList } = await import('../../app/ts/background/settings.js')
		const { setRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		// The home page identifies this rich address with the client, so building it sends a request that the test can hold.
		await setFixedMakeMeRichList([{ address: 0x3333333333333333333333333333333333333333n, makingRich: true, type: 'UserAdded' }])
		await setRpcConnectionStatus({ isConnected: false, lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'), latestBlock: undefined, rpcNetwork: networkA, retrying: false })
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// A signer-only network is selected in signing mode.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		let switchedToB = false
		// Waking A's client publishes its connection status after the refresh checked its network, and before the home page reads the settings.
		const publishRpcConnectionStatus = async () => {
			if (switchedToB) return
			switchedToB = true
			await switchToNetwork(signerOnlyB)
			// The home page has read B's settings once it identifies the rich address with A's client, which B kept; selecting A again keeps that client too.
			servicesA.interceptRequests(async (request) => {
				if (request.method === 'eth_getBlockByNumber' || request.method === 'eth_blockNumber') return
				servicesA.interceptRequests(undefined)
				await switchToNetwork(networkA)
			})
		}
		try {
			const messagesBefore = runtimeMessages.length
			await refreshHomeData(owner, websiteTabConnections, false, publishRpcConnectionStatus)

			assert.equal(switchedToB, true)
			assert.equal(installed.length, 1)
			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) assert.equal(homePage.settings.activeRpcNetwork.chainId, networkA.chainId)
		} finally {
			retireAll()
		}
	})

test.each(['to B', 'to B and back to A'] as const)('an invalidating refresh of A that waits for a metadata write while a switch %s commits writes and broadcasts nothing', async (switches) => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationForSnapshot, updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { updateSimulationMetadata } = await import('../../app/ts/background/simulationUpdating.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		let addressBookRead: ReturnType<typeof pauseNextStorageReadOf> | undefined
		try {
			await updatePopupVisualisationIfNeeded(servicesA.ethereum, servicesA.tokenPriceService, { invalidateOldState: true })
			const { simulation } = await modules.readNetworkSnapshot(owner)
			// The metadata refresh holds the stored visualisation's update while it looks up its addresses.
			addressBookRead = pauseNextStorageReadOf('userAddressBookEntriesV3')
			const metadata = updateSimulationMetadata(simulation, undefined)
			await addressBookRead.started
			// A's invalidating refresh passes its network checks and reads the stored visualisation twice, first to compare and then inside its serialized section; from there it queues its invalidation behind the held update without touching storage again.
			const refreshReadStoredVisualisation = whenStorageReadsReturned('popupVisualisation', 2)
			const refresh = updatePopupVisualisationForSnapshot(simulation, { invalidateOldState: true })
			await refreshReadStoredVisualisation
			reportSimulationConsumer(false)
			const switchToNetwork = async (rpcNetwork: RpcEntry) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
			await switchToNetwork(networkB)
			if (switches === 'to B and back to A') await switchToNetwork(networkA)
			const getWrites = countPopupVisualisationWrites()
			const messagesBeforeRelease = runtimeMessages.length
			addressBookRead.release()
			await Promise.all([metadata, refresh])

			assert.equal(getWrites(), 0)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			addressBookRead?.release()
			retireAll()
		}
	})

test.each(['to B', 'to signer-only B and back to A'] as const)('a cached home data request that a switch %s interrupts sends only a home page of the active network', async (switches) => {
		const { modules, runtimeMessages, createPopupContext } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		// A signer-only network is selected in signing mode.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		const finalNetwork = switches === 'to B' ? networkB : networkA
		// The home page reads the settings, then the current tab; refreshing the tab's signer accounts makes its last read a settings re-read. Without that refresh it keeps the settings read before the switch to B; with it, it reads signer-only B's settings before A is selected again.
		const refreshSignerAccounts = switches !== 'to B'
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		let step: 'waitingForCurrentTab' | 'switching' | 'waitingForSettingsReRead' | 'done' = 'waitingForCurrentTab'
		Object.defineProperty(browser.storage.local, 'get', {
			configurable: true,
			value: async (keys: Parameters<typeof originalGet>[0]) => {
				if (step === 'waitingForCurrentTab' && (keys === 'currentTabId' || (Array.isArray(keys) && keys.includes('currentTabId')))) {
					step = 'switching'
					await switchToNetwork(switches === 'to B' ? networkB : signerOnlyB)
					step = switches === 'to B' ? 'done' : 'waitingForSettingsReRead'
					return await originalGet(keys)
				}
				const result = await originalGet(keys)
				if (step === 'waitingForSettingsReRead' && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
					step = 'done'
					// The page has read signer-only B's settings; selecting A again keeps A's client.
					await switchToNetwork(networkA)
				}
				return result
			},
		})
		try {
			const messagesBefore = runtimeMessages.length
			await dispatchPopupMessage(await createPopupContext(owner), { method: 'popup_requestNewHomeData', data: { refreshSignerAccounts, includeWebsiteAccessAddressMetadata: false } })

			assert.equal(step, 'done')
			assert.deepEqual((await modules.getSettings()).activeRpcNetwork, finalNetwork)
			const homePages = runtimeMessages.slice(messagesBefore).flatMap((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UpdateHomePage' ? [parsed.value.data] : []
			})
			assert.ok(homePages.length > 0)
			for (const homePage of homePages) assert.equal(homePage.settings.activeRpcNetwork.chainId, finalNetwork.chainId)
		} finally {
			retireAll()
		}
	})

test.each(['visualisation store', 'metadata update'] as const)('a %s whose write waits behind a large state read while an endpoint switch commits writes and broadcasts nothing', async (path) => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp()
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		const { getSafeTransactionStacks, setPopupVisualisationState, updatePopupVisualisationWithCallBack } = await import('../../app/ts/background/storageVariables.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const networkAOnAnotherEndpoint = { ...networkA, name: 'Network A on another endpoint', httpsRpc: 'https://network-a-other.invalid' }
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const storedBefore = await modules.getPopupVisualisationState()
		const generationBefore = getCommittedNetworkChangeGeneration()
		// The check runs right before the write is queued for the large state semaphore, so its first call shows that the write has reached that wait.
		const writeQueued = createDeferredSignal()
		const isCurrent = () => {
			writeQueued.resolve()
			return getCommittedNetworkChangeGeneration() === generationBefore
		}
		const competingRead = queueBlockedLargeStateReadAfterNextVisualisationRead(getSafeTransactionStacks)
		try {
			const write = path === 'visualisation store'
				? setPopupVisualisationState({ ...storedBefore, simulationId: storedBefore.simulationId + 1, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }, isCurrent)
				: updatePopupVisualisationWithCallBack(async (oldResults) => ({ ...oldResults, simulationId: oldResults.simulationId + 1 }), isCurrent)
			await competingRead.blocked
			await writeQueued.promise
			// A same-chain endpoint change in signing mode needs no large state, so it commits while the write waits.
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkAOnAnotherEndpoint, promptForAccessesIfNeeded: false })
			assert.equal(getCommittedNetworkChangeGeneration(), generationBefore + 1)
			const getWrites = countPopupVisualisationWrites()
			const messagesBeforeRelease = runtimeMessages.length
			competingRead.release()
			const result = await write
			await competingRead.finished()

			assert.equal(getWrites(), 0)
			assert.deepEqual(result, { status: 'obsolete', results: storedBefore })
			assert.deepEqual(await modules.getPopupVisualisationState(), storedBefore)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.deepEqual(stateChanges, [])
		} finally {
			competingRead.release()
			retireAll()
		}
	})

test('a popup refresh queued on returning to A through a signer-only network runs and publishes instead of joining the obsolete refresh of A', async () => {
		const { modules, runtimeMessages } = await createApprovedSimulationDapp()
		const { queuePopupSimulationRefresh } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const [servicesA] = installed
		if (servicesA === undefined) throw new Error('Missing network A services')
		// A fresh cached head gives both refreshes of A a comparable revision; the queue reads it when it computes one.
		const head = await servicesA.ethereum.getBlock(undefined)
		const transitionRefreshQueued = createDeferredSignal()
		let nextHeadReadIsTransitionRefresh = false
		servicesA.ethereum.getCachedBlock = () => {
			if (nextHeadReadIsTransitionRefresh) {
				nextHeadReadIsTransitionRefresh = false
				transitionRefreshQueued.resolve()
			}
			return { ...head, timestamp: new Date() }
		}
		// The popup answers the first visibility probe only once the test releases it.
		const firstProbeSent = createDeferredSignal()
		const releaseFirstProbe = createDeferredSignal()
		let probes = 0
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', {
			configurable: true,
			value: async (message: unknown) => {
				if (!isRecord(message) || message.method !== 'popup_isSimulationVisualizerOpen') return await originalSendMessage(message)
				probes += 1
				if (probes === 1) {
					firstProbeSent.resolve()
					await releaseFirstProbe.promise
				}
				return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
			},
		})
		// A signer-only network is selected in signing mode; neither switch replaces A's client.
		const switchToNetwork = async (rpcNetwork: RpcNetwork) => await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: rpcNetwork.httpsRpc !== undefined, rpcNetwork, promptForAccessesIfNeeded: false })
		try {
			const generationBefore = getCommittedNetworkChangeGeneration()
			const network = await modules.readNetworkSnapshot(owner)
			const { simulation } = network
			const services = network.services
			const obsoleteRefresh = queuePopupSimulationRefresh(simulation)
			await firstProbeSent.promise
			await switchToNetwork(signerOnlyB)
			nextHeadReadIsTransitionRefresh = true
			const returnToA = switchToNetwork(networkA)
			// The head read happens while the return to A queues its refresh, which joins or follows the held one in the same call.
			await transitionRefreshQueued.promise
			assert.equal(getCommittedNetworkChangeGeneration(), generationBefore + 2)
			const storedBeforeRelease = await modules.getPopupVisualisationState()
			const messagesBeforeRelease = runtimeMessages.length
			releaseFirstProbe.resolve()
			await Promise.all([obsoleteRefresh, returnToA])

			assert.equal(installed.length, 1)
			assert.equal(probes, 2)
			assert.ok((await modules.getPopupVisualisationState()).simulationId > storedBeforeRelease.simulationId)
			const stateChanges = runtimeMessages.slice(messagesBeforeRelease).filter((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_simulation_state_changed'
			})
			assert.ok(stateChanges.length > 0)
		} finally {
			releaseFirstProbe.resolve()
			retireAll()
		}
	})

test('a refresh whose input is unchanged still runs when a discarded refresh left the stored result updating', async () => {
		const { modules } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const { updatePopupVisualisationForSnapshot } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			// With an empty stack only the made-rich address is simulated, so the stored input matches the snapshot's and the fingerprints agree.
			const network = await modules.readNetworkSnapshot(owner)
			const { simulation } = network
			const services = network.services
			await updatePopupVisualisationForSnapshot(simulation, { invalidateOldState: true })
			const completed = await modules.getPopupVisualisationState()
			assert.equal(completed.simulationState.kind, 'simulated')
			// Like a refresh that stored its updating state and was then discarded because its network was replaced, with the same input.
			const { setPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
			const { alwaysWrite } = await import('../../app/ts/utils/largeStateStore.js')
			await setPopupVisualisationState({ ...completed, simulationId: completed.simulationId + 1, simulationUpdatingState: 'updating' }, alwaysWrite)

			await updatePopupVisualisationForSnapshot(simulation, { skipIfUnchanged: true })

			const refreshed = await modules.getPopupVisualisationState()
			assert.equal(refreshed.simulationUpdatingState, 'done')
			assert.ok(refreshed.simulationId > completed.simulationId + 1)
		} finally {
			retireAll()
		}
	})

test.each(['the selection and then the list, as the editor does', 'only the list'] as const)('a currency edit of the active RPC that saves %s reaches the installed client without replacing it or retiring its snapshots', async (saved) => {
		installBrowserMock()
		const modules = await loadModules()
		const { getUpdatedSimulationState, getSimulationProviderForSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const { setNewRpcList } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
		const { setRpcList } = await import('../../app/ts/background/storageVariables.js')
		await setRpcList([{ ...networkA, primary: true }])
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: { ...networkA, primary: true } })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const before = await modules.readNetworkSnapshot(owner)
			const client = before.services.ethereum
			const editedNetwork = { ...networkA, primary: true, currencyName: 'Edited ether', currencyTicker: 'EDIT' }

			if (saved !== 'only the list') await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: editedNetwork, promptForAccessesIfNeeded: false })
			await setNewRpcList(owner, websiteTabConnections, { method: 'popup_set_rpc_list', data: [{ ...editedNetwork, primary: true }] })

			const after = await modules.readNetworkSnapshot(owner)
			assert.equal(after.services.ethereum, client)
			assert.equal(client.getRpcEntry().currencyName, 'Edited ether')
			assert.equal(client.getRpcEntry().currencyTicker, 'EDIT')
			assert.equal(after.settings.activeRpcNetwork.currencyTicker, 'EDIT')
			if (after.simulation.kind !== 'loaded' || before.simulation.kind !== 'loaded') throw new Error('Expected loaded simulations')
			assert.equal(after.simulation.networkChangeGeneration, before.simulation.networkChangeGeneration)
			assert.equal(after.simulation.interceptorTransactionStack.operations.length, 1)
			// The snapshot read before the edit still matches the client, so work in flight is not refused.
			assert.equal(getSimulationProviderForSnapshot(before.simulation), client)
			assert.equal(getSimulationProviderForSnapshot(after.simulation), client)
			const simulated = await getUpdatedSimulationState(after.simulation)
			if (simulated.kind !== 'simulated') throw new Error('Expected a simulation')
			assert.equal(simulated.value.rpcNetwork.currencyTicker, 'EDIT')
		} finally {
			retireAll()
		}
	})

test('a popup refresh that arrives during a network switch waits for it and reads one settings and services pair', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings } = await loadModules()
		const { popupSnapshotMessageHandler } = await import('../../app/ts/background/popupMessageHandlerRegistry.js')
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const observedPairs: { readonly settingsChainId: bigint, readonly servicesChainId: bigint }[] = []
		const handler = popupSnapshotMessageHandler('popup_requestSimulationMetadata', async (context) => {
			observedPairs.push({ settingsChainId: context.network.settings.activeRpcNetwork.chainId, servicesChainId: context.network.services.ethereum.getChainId() })
		})
		const context: PopupMessageDispatcherContext = {
			websiteTabConnections: new Map(),
			simulationServicesOwner: owner,
			settings: await getSettings(),
			publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
			simulationAbortController: new AbortController(),
			confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => undefined,
		}
		const pausedSwitch = pauseAfterActiveNetworkWrite()
		try {
			const networkSwitch = changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await pausedSwitch.written
			const refresh = handler(context, { method: 'popup_requestSimulationMetadata' })
			// Mock storage settles in microtasks, so one macrotask turn lets the refresh run until it waits for the switch.
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(observedPairs, [])
			pausedSwitch.release()
			await Promise.all([networkSwitch, refresh])
			assert.deepEqual(observedPairs, [{ settingsChainId: networkB.chainId, servicesChainId: networkB.chainId }])
		} finally {
			pausedSwitch.release()
			retireAll()
		}
	})

test('a block callback starting between generation retirement and service installation cannot adopt the new generation', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules } = dapp
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const servicesA = getInstalled()
		const block = await servicesA.ethereum.getBlock(undefined)
		if (block === null) throw new Error('Expected a block')
		const published: string[] = []
		const { createNewBlockAttemptCallback } = await import('../../app/ts/background/newBlockHandling.js')
		const { advanceCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		const callback = createNewBlockAttemptCallback({ getSimulationServices: owner.getCurrent, websiteTabConnections: dapp.websiteTabConnections, publishRpcConnectionStatus: async (method) => { published.push(method) } })
		let delivery: Promise<unknown> | undefined
		try {
			await modules.runNetworkTransition(async () => {
				advanceCommittedNetworkChangeGeneration()
				delivery = callback(block, servicesA.ethereum, true)
				await Promise.resolve()
				await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkB })
				owner.reset(networkB)
			})
			await delivery
			assert.deepEqual(published, [])
			assert.deepEqual(dapp.messages.filter((message) => message.method === 'newHeads'), [])
		} finally {
			retireAll()
		}
	})

test('a retained polling client sends no active-network events for a signer-only selection', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const { ethereum } = getInstalled()
		const { createNewBlockAttemptCallback } = await import('../../app/ts/background/newBlockHandling.js')
		const published: string[] = []
		const callback = createNewBlockAttemptCallback({ getSimulationServices: owner.getCurrent, websiteTabConnections: dapp.websiteTabConnections, publishRpcConnectionStatus: async (method) => { published.push(method) } })
		try {
			await dapp.modules.runSettingsTransition(owner, new Map(), { writeSettings: async () => {
				await dapp.modules.changeSimulationMode({ simulationMode: false, rpcNetwork: signerOnlyB })
				return 'committed'
			} })
			assert.equal(getInstalled().ethereum, ethereum)
			await callback(await ethereum.getBlock(undefined), ethereum, true)
			assert.deepEqual(published, [])
		} finally {
			retireAll()
		}
	})

test.each([false, true])('a gas edit admitted before a network switch cannot mutate the new stack (switchBack=%s)', async (switchBack) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const admitted = await modules.readNetworkSnapshot(owner)
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			if (switchBack) await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			const operations = [createStackedTransaction(1n, switchBack ? networkA.chainId : networkB.chainId, STACKED_ON_A_RECIPIENT)]
			await modules.updateInterceptorTransactionStack(() => ({ operations }))
			await modules.forceSetGasLimitForTransaction(admitted, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: 1n, gasLimit: 25_000n } })
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, operations)
		} finally {
			retireAll()
		}
	})

test('a block of a client that a network switch replaces while the handler is suspended simulates nothing and publishes no newHeads, and the next block of the installed client carries on', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules, switchToNetworkB } = dapp
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const statusPublishStarted = createDeferredSignal()
		const statusPublishRelease = createDeferredSignal()
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner, async () => {
			statusPublishStarted.resolve()
			await statusPublishRelease.promise
		})
		const servicesA = getInstalled()
		try {
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			await statusPublishStarted.promise
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			statusPublishRelease.resolve()
			await blockOfReplacedClient

			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.deepEqual(getNewHeads(), [])

			const servicesB = getInstalled()
			assert.notEqual(servicesB, servicesA)
			await deliverNewBlock(servicesB)
			assert.ok(getSimulatedCallRecipients(servicesB).includes(STACKED_ON_B_RECIPIENT))
			// The live block, then the simulated block of B's stack on top of it.
			assert.equal(getNewHeads().length, 2)
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			statusPublishRelease.resolve()
			retireAll()
		}
	})

test('a block that reads the stack while an endpoint change is in flight simulates nothing on the client that change replaces', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules } = dapp
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner)
		const settingsWritten = createDeferredSignal()
		const transitionRelease = createDeferredSignal()
		const servicesA = getInstalled()
		try {
			// Holds the transition after its settings write, so the handler finds the change committed but its client not yet replaced, and its stack read waits for the lock.
			const endpointChange = modules.runSettingsTransition(owner, new Map(), {
				writeSettings: async () => {
					await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkAOnOtherEndpoint })
					settingsWritten.resolve()
					await transitionRelease.promise
					return 'committed'
				},
			})
			await settingsWritten.promise
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			// The callback must wait for installation, even though the old client is still installed now.
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(getNewHeads(), [])
			assert.equal(servicesA.ethereum.isRetired(), false)
			transitionRelease.resolve()
			await endpointChange
			await blockOfReplacedClient

			assert.equal(servicesA.ethereum.isRetired(), true)
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
			assert.equal(getNewHeads().length, 0)
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			transitionRelease.resolve()
			retireAll()
		}
	})

test('simulated blocks that were computed on a client a network switch retires meanwhile are not published', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules, switchToNetworkB } = dapp
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const { deliverNewBlock, getNewHeads } = await subscribeDappToNewBlocks(dapp, owner)
		const simulationStarted = createDeferredSignal()
		const simulationRelease = createDeferredSignal()
		const servicesA = getInstalled()
		servicesA.interceptRequests(async (request) => {
			if (request.method !== 'eth_simulateV1') return
			simulationStarted.resolve()
			await simulationRelease.promise
		})
		try {
			const blockOfReplacedClient = deliverNewBlock(servicesA)
			await simulationStarted.promise
			await switchToNetworkB(owner)
			simulationRelease.resolve()
			await blockOfReplacedClient

			// The simulation paired A's client with A's stack; only its result arrived after the switch.
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.equal(servicesA.ethereum.isRetired(), true)
			assert.equal(getNewHeads().length, 1)
			assert.equal(await modules.getLatestUnexpectedError(), undefined)
		} finally {
			simulationRelease.resolve()
			retireAll()
		}
	})

for (const callbackFailures of [1, 2]) {
	test(`network repair retries a transition callback that fails ${ callbackFailures } times before notifying websites`, async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const { runSettingsTransition } = await import('../../app/ts/background/networkTransition.js')
		const failure = new Error('Committed approval reconciliation failed')
		let attempts = 0
		let reconciled = false
		try {
			await assert.rejects(runSettingsTransition(owner, websiteTabConnections, {
				writeSettings: async () => { await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: networkB }); return 'committed' },
				afterNetworkApplied: async (settings) => {
					assert.equal(settings.activeRpcNetwork.chainId, networkB.chainId)
					assert.deepEqual(getChainChangedResults(), [])
					if (++attempts <= callbackFailures) throw failure
					reconciled = true
				},
			}), (error) => error === failure)
			if (callbackFailures === 2) {
				assert.equal(reconciled, false)
				assert.deepEqual(getChainChangedResults(), [])
			}
			await modules.readNetworkSnapshot(owner)
			assert.equal(reconciled, true)
			assert.equal(attempts, callbackFailures + 1)
			assert.deepEqual(getChainChangedResults(), [`0x${ networkB.chainId.toString(16) }`])
			await modules.readNetworkSnapshot(owner)
			assert.equal(attempts, callbackFailures + 1, 'a completed callback is not replayed')
		} finally {
			retireAll()
		}
	})
}
