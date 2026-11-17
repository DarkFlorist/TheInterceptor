import { test } from 'bun:test'
import { Transaction } from 'micro-eth-signer'
import * as assert from 'node:assert'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'
import { createDeferredSignal, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { addTransactionToNetworkBStack, assertCommittedNetworkBEffects, containsAddress, createApprovedConnection, createApprovedSimulationDapp, createImportRequest, createNetworkServices, createRecordingServicesOwner, createStackedTransaction, createStorageReadPause, failFirstSettingsReadAfterNetworkWrite, failNextStorageWrite, failStorageWrites, firstAddress, getOverriddenAddressesPerSimulateV1Request, getRichAddressesInSimulateV1Request, getSimulatedCallRecipients, getSimulateV1Requests, networkA, networkAOnOtherEndpoint, networkB, pauseAfterActiveNetworkWrite, rawTransactionSignerKey, reportSimulationConsumer, secondAddress, STACKED_ON_A_RECIPIENT, STACKED_ON_B_RECIPIENT, stackImportRequest, website, websiteOrigin } from './networkTransitionTestHarness.js'
import { readTestNetworkSnapshot } from './simulationInputTestHelper.js'

test('a retired client stays asleep and publishes no connection status when something tries to wake it', async () => {
		installBrowserMock()
		const { makeSureInterceptorIsNotSleeping } = await import('../../app/ts/background/sleeping.js')
		const { setRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
		const retired = createNetworkServices(networkA)
		const installed = createNetworkServices(networkB)
		// A stored status, so a wake-up of a sleeping client publishes one.
		await setRpcConnectionStatus({ isConnected: true, lastConnnectionAttempt: new Date(), rpcNetwork: networkB, latestBlock: undefined, retrying: false })
		const publishedStatuses: unknown[] = []
		const recordPublishedStatus: typeof noopPublishRpcConnectionStatus = async (_method, status) => { publishedStatuses.push(status) }
		try {
			retired.ethereum.cleanup()
			retired.ethereum.setBlockPolling(true)
			assert.equal(retired.ethereum.isBlockPolling(), false)
			await makeSureInterceptorIsNotSleeping(retired.ethereum, recordPublishedStatus)
			assert.equal(retired.ethereum.isBlockPolling(), false)
			assert.deepEqual(retired.requests, [])
			assert.deepEqual(publishedStatuses, [])

			await makeSureInterceptorIsNotSleeping(installed.ethereum, recordPublishedStatus)
			assert.equal(installed.ethereum.isBlockPolling(), true)
			assert.equal(publishedStatuses.length, 1)
		} finally {
			retired.ethereum.cleanup()
			installed.ethereum.cleanup()
		}
	})

test('a request admitted before a network switch keeps the services, settings and stack it was admitted with', async () => {
		const { modules, sendEthSimulateV1, switchToNetworkB, assertRequestSucceeded } = await createApprovedSimulationDapp()
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		// Pause the request at its first storage read after it captured its services, then let the switch complete.
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			const request = sendEthSimulateV1(capturingOwner)
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA, servicesB] = installed
			if (servicesA === undefined || servicesB === undefined) throw new Error('Expected the switch to install network B services')
			assert.equal(getInstalled(), servicesB)
			readPause.release()
			await request

			assertRequestSucceeded()
			// The stacked transaction adds a nonce and base fee preparation simulation; every simulation used the admitted settings.
			for (const overriddenAddresses of getOverriddenAddressesPerSimulateV1Request(servicesA)) assert.deepEqual(overriddenAddresses, [addressString(firstAddress)])
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
			assert.deepEqual(getSimulateV1Requests(servicesB), [])
			// The request wakes only the client it runs on, which the switch retired, so neither client polls; the installed client is woken by work on its own network.
			assert.equal(servicesA.ethereum.isBlockPolling(), false)
			assert.equal(servicesB.ethereum.isBlockPolling(), false)
		} finally {
			readPause.release()
			retireAll()
		}
	})

test.each([
		['eth_sendTransaction', false],
		['eth_sendRawTransaction', false],
		['eth_sendTransaction', true],
		['eth_sendRawTransaction', true],
	] as const)('a %s admitted before a network switch is prepared, simulated and shown with the network and stack it was admitted on (confirmation window open: %p)', async (method, simulationConsumerOpen) => {
		const { modules, sendDappRequest, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const readPause = createStorageReadPause()
		// Pause the request at its first storage read after it captured its services, then let the switch complete.
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		const transaction = { from: addressString(firstAddress), to: addressString(secondAddress), value: '0x0', data: '0x' }
		const rawTransaction = Transaction.prepare({ type: 'eip1559', chainId: networkA.chainId, nonce: 0n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, gasLimit: 21_000n, to: transaction.to, value: 0n, data: '0x', accessList: [] }, false).signBy(rawTransactionSignerKey).toHex()
		try {
			const request = sendDappRequest(capturingOwner, method === 'eth_sendTransaction' ? { method, params: [transaction] } : { method, params: [rawTransaction] })
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			const [servicesA, servicesB] = installed
			if (servicesA === undefined || servicesB === undefined) throw new Error('Expected the switch to install network B services')
			readPause.release()
			await request

			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
			if (!pending.transactionToSimulate.success) throw new Error('Expected the transaction to be prepared')
			assert.equal(pending.transactionToSimulate.transaction.chainId, networkA.chainId)
			const confirmationSimulation = pending.popupVisualisation
			if (confirmationSimulation.statusCode !== 'success') throw new Error('Expected the confirmation simulation to succeed')
			assert.equal(confirmationSimulation.data.simulationState.rpcNetwork.chainId, networkA.chainId)
			const confirmationOverrides = confirmationSimulation.data.simulationState.simulationStateInput.flatMap((block) => Object.keys(block.stateOverrides))
			assert.ok(confirmationOverrides.includes(addressString(firstAddress)))
			assert.ok(!confirmationOverrides.includes(addressString(secondAddress)))
			const confirmationRecipients = confirmationSimulation.data.simulationState.simulationStateInput.flatMap((block) => block.transactions.map((stacked) => stacked.signedTransaction.to))
			assert.ok(confirmationRecipients.includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!confirmationRecipients.includes(STACKED_ON_B_RECIPIENT))
			assert.ok(getSimulatedCallRecipients(servicesA).includes(STACKED_ON_A_RECIPIENT))
			assert.ok(!getSimulatedCallRecipients(servicesA).includes(STACKED_ON_B_RECIPIENT))
			// Gas estimation runs only for eth_sendTransaction, so it adds a simulation before the confirmation simulation.
			const simulationsOnA = getOverriddenAddressesPerSimulateV1Request(servicesA)
			assert.ok(simulationsOnA.length >= (method === 'eth_sendTransaction' ? 2 : 1))
			for (const overriddenAddresses of simulationsOnA) {
				assert.ok(overriddenAddresses.includes(addressString(firstAddress)))
				assert.ok(!overriddenAddresses.includes(addressString(secondAddress)))
			}
			if (simulationConsumerOpen) {
				// The open window also shows B's own stack after the switch, simulated on B's client with B's settings.
				for (const overriddenAddresses of getOverriddenAddressesPerSimulateV1Request(servicesB)) assert.ok(!overriddenAddresses.includes(addressString(firstAddress)))
				assert.ok(!getSimulatedCallRecipients(servicesB).includes(STACKED_ON_A_RECIPIENT))
			} else {
				assert.deepEqual(getSimulateV1Requests(servicesB), [])
			}
		} finally {
			readPause.release()
			retireAll()
		}
	})

test.each(['2.0.0', '1.0.1'] as const)('a simulation stack request for version %s admitted before a network switch replies with the stack it was admitted with', async (version) => {
		const { modules, socket, websiteTabConnections, sendDappRequest, switchToNetworkB, getReply } = await createApprovedSimulationDapp()
		const { getUpdatedSimulationStackSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const { resolveFetchSimulationStackRequest } = await import('../../app/ts/background/windows/fetchSimulationStack.js')
		// Sharing decisions are remembered per stack, so each version shares a different stack.
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(version === '2.0.0' ? 1n : 3n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const stackRequest = { method: 'interceptor_getSimulationStack', params: [version] }
		const dialogOpened = createDeferredSignal()
		const originalCreateWindow = browser.windows.create.bind(browser.windows)
		Object.defineProperty(browser.windows, 'create', {
			configurable: true,
			value: async (...args: Parameters<typeof originalCreateWindow>) => {
				dialogOpened.resolve()
				return await originalCreateWindow(...args)
			},
		})
		const readPause = createStorageReadPause()
		const capturingOwner: SimulationServicesOwner = {
			...owner,
			getCurrent: () => {
				readPause.arm()
				return owner.getCurrent()
			},
		}
		try {
			// The user shares this stack once, so a later request for the same stack is answered without a dialog.
			const firstRequest = sendDappRequest(owner, stackRequest, 1)
			await dialogOpened.promise
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			await resolveFetchSimulationStackRequest(await getUpdatedSimulationStackSnapshot(true, (await modules.readNetworkSnapshot(owner)).simulation), websiteTabConnections, {
				method: 'popup_fetchSimulationStackRequestConfirmation',
				data: { accept: true, simulationStackVersion: version, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } },
			})
			await firstRequest

			const secondRequest = sendDappRequest(capturingOwner, stackRequest, 2)
			await readPause.started
			await switchToNetworkB(owner)
			await addTransactionToNetworkBStack(modules)
			readPause.release()
			await secondRequest

			const result = getReply('interceptor_getSimulationStack', 2)?.result
			const reply = JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? addressString(value) : value).toLowerCase()
			assert.ok(reply.includes(addressString(STACKED_ON_A_RECIPIENT).toLowerCase()))
			assert.ok(!reply.includes(addressString(STACKED_ON_B_RECIPIENT).toLowerCase()))
			if (version === '1.0.1') {
				// Version 1.0.x lists the funding of the made-rich address first; the switch made B's active address the rich one.
				const funding = isRecord(result) && Array.isArray(result.payload) ? result.payload[0] : undefined
				assert.ok(isRecord(funding) && typeof funding.to === 'string')
				assert.equal(BigInt(funding.to), firstAddress)
			}
		} finally {
			readPause.release()
			retireAll()
		}
	})

test('a failed initial stack chain identity write prevents committing a network switch', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			failNextStorageWrite('simulationStackChainId', new Error('Cannot persist stack chain'))
			await assert.rejects(modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), /Cannot persist stack chain/u)
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkA.chainId)
			assert.equal(owner.getCurrent().ethereum.getRpcEntry().chainId, networkA.chainId)
			await modules.readNetworkSnapshot(owner)
		} finally {
			retireAll()
		}
	})

test('another settings transition cannot commit while the earlier chain cleanup is still failing', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			failStorageWrites('interceptorTransactionStack', 3, new Error('Cannot clear old stack'))
			await assert.rejects(modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), /Cannot clear old stack/u)
			// Returning to A before cleanup finishes would hide the mismatch from restart recovery and let A's old stack survive the chain changes.
			await assert.rejects(modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false }), /Cannot clear old stack/u)
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkB.chainId)
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkA.chainId)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
		} finally {
			retireAll()
		}
	})

test.each(['interceptorTransactionStack', 'simulationStackChainId'])('an import cannot append during failed restart cleanup of %s, and succeeds after repair', async (failedKey) => {
		installBrowserMock()
		const modules = await loadModules()
		const { browserStorageLocalSet, browserStorageLocalGet } = await import('../../app/ts/utils/storageUtils.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkB })
		await browserStorageLocalSet({ simulationStackChainId: networkA.chainId })
		const operations = [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)]
		await modules.updateInterceptorTransactionStack(() => ({ operations }))
		const { owner, retireAll } = createRecordingServicesOwner(networkB)
		try {
			// The dispatch read, captured admission, and writer lock all encounter unavailable cleanup.
			failStorageWrites(failedKey, 3, new Error('Restart cleanup is unavailable'))
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'unavailable')
			const { ethereum, tokenPriceService } = owner.getCurrent()
			const failedImport = await modules.importSimulationStack(await readTestNetworkSnapshot({ ethereum, tokenPriceService }), stackImportRequest)
			assert.equal(failedImport.ok, false)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, failedKey === 'interceptorTransactionStack' ? operations : [])
			assert.equal((await browserStorageLocalGet('simulationStackChainId')).simulationStackChainId, networkA.chainId)
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'loaded')
			assert.equal((await modules.importSimulationStack(await readTestNetworkSnapshot({ ethereum, tokenPriceService }), stackImportRequest)).ok, true)
			await modules.readNetworkSnapshot(owner)
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, stackImportRequest.data.interceptorSimulateStack.operations)
		} finally {
			retireAll()
		}
	})

test('a chain switch tells websites after it installed the services and cleared the stack, and before it releases the lock', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const recording = createRecordingServicesOwner(networkA)
		const events: string[] = []
		const owner: SimulationServicesOwner = { getCurrent: recording.owner.getCurrent, reset: (rpcNetwork) => { events.push('services installed'); return recording.owner.reset(rpcNetwork) } }
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
		let readAfterTheLock: Promise<void> | undefined
		const postMessage = port.postMessage.bind(port)
		port.postMessage = (message) => {
			if (message.method === 'chainChanged' || message.method === 'accountsChanged') events.push(`website: ${ message.method }`)
			// This read queues on the lock while the notifications run, so it finishes only once the transition released it.
			readAfterTheLock ??= modules.readNetworkSnapshot(owner).then(() => { events.push('lock released') })
			postMessage(message)
		}
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
			await originalSet(items)
			if ('interceptorTransactionStack' in items) events.push('stack cleared')
		} })
		try {
			await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await readAfterTheLock
			assert.deepEqual(events, ['services installed', 'stack cleared', 'website: chainChanged', 'website: accountsChanged', 'lock released'])
		} finally {
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
			recording.retireAll()
		}
	})

test('a repair applies the network change effects in the order of a first application', async () => {
		const { getCommittedNetworkChangeGeneration } = await import('../../app/ts/background/networkChangeGeneration.js')
		// Records each effect once it took place: the generation advance is seen at the next recorded step, the others as they happen.
		const recordNetworkChange = async (installationFailuresBeforeSuccess: number) => {
			installBrowserMock()
			const modules = await loadModules()
			await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
			await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
			const recording = createRecordingServicesOwner(networkA)
			const events: string[] = []
			const generationBefore = getCommittedNetworkChangeGeneration()
			const record = (event: string) => {
				if (!events.includes('snapshots retired') && getCommittedNetworkChangeGeneration() > generationBefore) events.push('snapshots retired')
				events.push(event)
			}
			let remainingInstallationFailures = installationFailuresBeforeSuccess
			const owner: SimulationServicesOwner = {
				getCurrent: recording.owner.getCurrent,
				reset: (rpcNetwork) => {
					if (remainingInstallationFailures > 0) {
						remainingInstallationFailures -= 1
						record('installation failed')
						throw new Error('Injected installation failure')
					}
					record('services installed')
					return recording.owner.reset(rpcNetwork)
				},
			}
			const socket = { tabId: 1, connectionName: 0n }
			const { port } = createPort(socket.tabId)
			const websiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
			const postMessage = port.postMessage.bind(port)
			port.postMessage = (message) => {
				if (message.method === 'chainChanged') record('websites told the chain')
				postMessage(message)
			}
			const originalSet = browser.storage.local.set.bind(browser.storage.local)
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
				await originalSet(items)
				if ('interceptorTransactionStack' in items) record('stack cleared')
			} })
			const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
			Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: unknown) => {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_chain_update') record('popups told the chain')
				return await originalSendMessage(message)
			} })
			try {
				const change = modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
				if (installationFailuresBeforeSuccess === 0) await change
				else await assert.rejects(change, /Injected installation failure/u)
				// The next lock holder repairs what the failed transition left.
				await modules.readNetworkSnapshot(owner)
			} finally {
				Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
				Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: originalSendMessage })
				recording.retireAll()
			}
			return events.filter((event) => event !== 'installation failed')
		}

		const firstApplication = await recordNetworkChange(0)
		// The transition retries once inside the lock, so two failures leave the change to the repair of the next read.
		const repaired = await recordNetworkChange(2)
		assert.deepEqual(firstApplication, ['snapshots retired', 'services installed', 'stack cleared', 'websites told the chain', 'popups told the chain'])
		assert.deepEqual(repaired, firstApplication)
	})

test('partially delivered website notifications are not duplicated when the unfinished change is repaired', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: true }
		const brokenConnections: Record<string, typeof connection | undefined> = { [modules.websiteSocketToString(socket)]: connection, broken: undefined }
		const websiteTabConnections = new Map([[socket.tabId, { connections: brokenConnections }]])
		try {
			await assert.rejects(modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }), /missing connection/u)
			const unfinished = await modules.readNetworkSnapshot(owner)
			assert.deepEqual(unfinished.settings.activeRpcNetwork, networkB)
			assert.equal(unfinished.simulation.kind, 'unavailable')
			assert.deepEqual(messages.filter((message) => message.method === 'chainChanged').map((message) => message.result), ['0xa'])

			delete brokenConnections.broken
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'loaded')
			assert.deepEqual(messages.filter((message) => message.method === 'chainChanged').map((message) => message.result), ['0xa'])
			// The repair owes only the change's own effects; the account notification belongs to the transition that failed.
			assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		} finally {
			retireAll()
		}
	})

test('a network switch releases the transition lock before its popup simulation runs, so requests do not wait for that simulation', async () => {
		const { modules, switchToNetworkB } = await createApprovedSimulationDapp({ simulationConsumerOpen: true })
		const recording = createRecordingServicesOwner(networkA)
		const simulationStarted = createDeferredSignal()
		const releaseSimulation = createDeferredSignal()
		// Services installed by the switch hold their first simulation until the test releases it.
		const owner: SimulationServicesOwner = {
			getCurrent: recording.owner.getCurrent,
			reset: (rpcNetwork) => {
				const services = recording.owner.reset(rpcNetwork)
				recording.getInstalled().interceptRequests(async (request) => {
					if (request.method !== 'eth_simulateV1') return
					simulationStarted.resolve()
					await releaseSimulation.promise
				})
				return services
			},
		}
		let deadline: ReturnType<typeof setTimeout> | undefined
		try {
			const switching = switchToNetworkB(owner)
			await simulationStarted.promise
			const snapshot = await Promise.race([
				modules.readNetworkSnapshot(owner),
				new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The snapshot read waited for the popup simulation')), 1000) }),
			])
			assert.equal(snapshot.settings.activeRpcNetwork.chainId, networkB.chainId)
			releaseSimulation.resolve()
			await switching
		} finally {
			clearTimeout(deadline)
			releaseSimulation.resolve()
			recording.retireAll()
		}
	})

test('a request that arrives during a network switch waits for it and uses the new network', async () => {
		const { sendEthSimulateV1, switchToNetworkB, assertRequestSucceeded } = await createApprovedSimulationDapp()
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const pausedSwitch = pauseAfterActiveNetworkWrite()
		try {
			const networkSwitch = switchToNetworkB(owner)
			await pausedSwitch.written
			const request = sendEthSimulateV1(owner)
			// Mock storage settles in microtasks, so one macrotask turn lets the request run until it waits for the switch.
			await new Promise((resolve) => setTimeout(resolve, 0))
			const [servicesA] = installed
			if (servicesA === undefined) throw new Error('Missing network A services')
			assert.deepEqual(servicesA.requests, [])
			assert.equal(installed.length, 1)

			pausedSwitch.release()
			await Promise.all([networkSwitch, request])
			const servicesB = installed[1]
			if (servicesB === undefined) throw new Error('Expected the switch to install network B services')
			assertRequestSucceeded()
			assert.deepEqual(getRichAddressesInSimulateV1Request(servicesB), [addressString(secondAddress)])
			assert.deepEqual(getSimulateV1Requests(servicesA), [])
		} finally {
			pausedSwitch.release()
			retireAll()
		}
	})

test('an RPC list update with stale popup settings selects the new primary of the chain that is active when it runs, in settings and services', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { settingsPopupMessageHandlers } = await import('../../app/ts/background/popupMessageHandlerRegistries/settings.js')
		const { updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const context: PopupMessageDispatcherContext = {
				websiteTabConnections: new Map(),
				simulationServicesOwner: owner,
				settings: await modules.getSettings(),
				publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
				simulationAbortController: new AbortController(),
				confirmTransactionAbortController: new AbortController(),
				resetSimulationState: async () => undefined,
			}
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			const replacedServicesOfB = getInstalled()
			const replacementPrimaryForB = { ...networkB, name: 'Network B replacement', httpsRpc: 'https://network-b-replacement.invalid' }
			await settingsPopupMessageHandlers.popup_set_rpc_list(context, { method: 'popup_set_rpc_list', data: [networkA, replacementPrimaryForB, { ...networkB, primary: false }] })

			assert.equal(context.settings.activeRpcNetwork.chainId, networkA.chainId)
			assert.deepEqual((await modules.getSettings()).activeRpcNetwork, replacementPrimaryForB)
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), replacementPrimaryForB)
			assert.equal(installed.length, 3)

			// Settings and services agree on the replacement, so a refresh visualises B's stack on it.
			reportSimulationConsumer(true)
			await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(2n, networkB.chainId, STACKED_ON_B_RECIPIENT)] }))
			const replacementServices = getInstalled()
			await updatePopupVisualisationIfNeeded(replacementServices.ethereum, replacementServices.tokenPriceService, { invalidateOldState: true })
			const visualisation = await modules.getPopupVisualisationState()
			if (visualisation.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
			assert.deepEqual(visualisation.simulationState.value.rpcNetwork, replacementPrimaryForB)
			assert.ok(containsAddress(visualisation, STACKED_ON_B_RECIPIENT))
			assert.ok(getSimulatedCallRecipients(replacementServices).includes(STACKED_ON_B_RECIPIENT))

			// A refresh that still holds the replaced services does nothing.
			const simulationsOnReplacedServices = getSimulateV1Requests(replacedServicesOfB).length
			await updatePopupVisualisationIfNeeded(replacedServicesOfB.ethereum, replacedServicesOfB.tokenPriceService, { invalidateOldState: true })
			assert.equal(getSimulateV1Requests(replacedServicesOfB).length, simulationsOnReplacedServices)
			assert.deepEqual(await modules.getPopupVisualisationState(), visualisation)
		} finally {
			retireAll()
		}
	})

test('importing settings with a different active network installs services for that network', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, getSettings, importSettings } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, installed, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const reply = await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkB))

			assert.equal(reply.data.success, true)
			assert.deepEqual((await getSettings()).activeRpcNetwork, networkB)
			assert.deepEqual(getInstalled().ethereum.getRpcEntry(), networkB)
			assert.equal(installed.length, 2)
			assert.equal(installed[0]?.ethereum.isBlockPolling(), false)
		} finally {
			retireAll()
		}
	})

test.each(['switch', 'settings import'] as const)('a %s that commits another chain installs its services and clears the stack before websites and popups hear of the chain', async (kind) => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const recording = createRecordingServicesOwner(networkA)
		const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
		const events: string[] = []
		const owner: SimulationServicesOwner = {
			getCurrent: recording.owner.getCurrent,
			reset: (rpcNetwork) => {
				events.push('installServices')
				return recording.owner.reset(rpcNetwork)
			},
		}
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', {
			configurable: true,
			value: async (items: Record<string, unknown>) => {
				await originalSet(items)
				if ('interceptorTransactionStack' in items) events.push('clearStack')
			},
		})
		const originalSendMessage = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', {
			configurable: true,
			value: async (message: unknown) => {
				if (isRecord(message) && message.method === 'popup_chain_update') events.push('popup_chain_update')
				return await originalSendMessage(message)
			},
		})
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId, (message) => { if (message.method === 'chainChanged') events.push('chainChanged') })
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		try {
			if (kind === 'switch') await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			else await modules.importSettings(owner, websiteTabConnections, importRequest)
			assert.deepEqual(events, ['installServices', 'clearStack', 'chainChanged', 'popup_chain_update'])
			assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
		} finally {
			recording.retireAll()
		}
	})

test('a failed atomic settings import keeps the old network and stack, and its retry completes the new network', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
			// The canonical import writes this preference and the network atomically.
			const failure = new Error('Injected signer preference write failure')
			failNextStorageWrite('useSignersAddressAsActiveAddress', failure)
			assert.equal((await modules.importSettings(owner, websiteTabConnections, importRequest)).data.success, false)
			assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkA.chainId)
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
			assert.deepEqual(getChainChangedResults(), [])
			assert.equal(installed.length, 1)

			assert.equal((await modules.importSettings(owner, websiteTabConnections, importRequest)).data.success, true)
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

test('a settings import whose first settings read afterwards fails still completes its network change', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		try {
			const importRequest = await createImportRequest(modules.exportSettingsAndAddressBook, networkB)
			const failure = new Error('Injected settings read failure')
			failFirstSettingsReadAfterNetworkWrite(failure)
			// The failed bootstrap refresh is reported independently; the committed network still completes.
			assert.equal((await modules.importSettings(owner, websiteTabConnections, importRequest)).data.success, true)
			await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

test('a simulation-mode import keeps the simulation stack on the same chain and clears it for another chain', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, getInterceptorTransactionStack, importSettings, updateInterceptorTransactionStack } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		await updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		try {
			await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkA))
			assert.equal((await getInterceptorTransactionStack()).operations.length, 1)

			await importSettings(owner, new Map(), await createImportRequest(exportSettingsAndAddressBook, networkB))
			assert.deepEqual((await getInterceptorTransactionStack()).operations, [])
		} finally {
			retireAll()
		}
	})

test('an import that changes the chain sends chainChanged to approved websites, and a same-chain import does not', async () => {
		installBrowserMock()
		const { changeSimulationMode, exportSettingsAndAddressBook, importSettings, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		await changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(websiteSocketToString)
		try {
			await importSettings(owner, websiteTabConnections, await createImportRequest(exportSettingsAndAddressBook, networkA))
			assert.deepEqual(getChainChangedResults(), [])

			await importSettings(owner, websiteTabConnections, await createImportRequest(exportSettingsAndAddressBook, networkB))
			assert.deepEqual(getChainChangedResults(), ['0xa'])
		} finally {
			retireAll()
		}
	})

test('a signing-mode network switch whose signing preference write fails still completes that network change, and so does its retry', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const switchSignerToNetworkB = async () => await modules.activateAddressSelection(owner, websiteTabConnections, { type: 'signer', address: firstAddress }, {
			simulationMode: false,
			signerAddress: firstAddress,
			rpcNetwork: networkB,
			promptForAccessesIfNeeded: false,
		})
		try {
			// The switch remembers the signing preference after it has stored the new network and installed its services, before it notifies websites.
			const failure = new Error('Injected signing preference write failure')
			failNextStorageWrite('signingAddressPreferences', failure)
			await assert.rejects(switchSignerToNetworkB(), (error) => error === failure)
			// The simulation stack carries no chain, so even a signing-mode chain change drops it.
			const afterFailure = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await switchSignerToNetworkB()
			const afterRetry = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(afterRetry.services, afterFailure.services)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

test('a simulation-mode network switch whose first settings read after the switch fails still completes that network change, and so does its retry', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, installed, retireAll } = createRecordingServicesOwner(networkA)
		const { websiteTabConnections, getChainChangedResults } = createApprovedConnection(modules.websiteSocketToString)
		const switchToNetworkB = async () => await modules.changeActiveAddressAndChain(owner, websiteTabConnections, { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
		try {
			const failure = new Error('Injected settings read failure')
			failFirstSettingsReadAfterNetworkWrite(failure)
			await assert.rejects(switchToNetworkB(), (error) => error === failure)
			const afterFailure = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)

			await switchToNetworkB()
			const afterRetry = await assertCommittedNetworkBEffects(modules, owner, getChainChangedResults, 0)
			assert.equal(afterRetry.services, afterFailure.services)
			assert.equal(installed.length, 2)
		} finally {
			retireAll()
		}
	})

test('an unavailable stack cannot turn mismatched services into a coherent snapshot', async () => {
		const { modules } = await createApprovedSimulationDapp()
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		const replacedServices = createNetworkServices(networkB)
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		const failure = new Error('Simulation input is unavailable')
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys: Parameters<typeof originalGet>[0]) => {
			if (keys === 'preSimulationBlockTimeManipulation' || Array.isArray(keys) && keys.includes('preSimulationBlockTimeManipulation')) throw failure
			return await originalGet(keys)
		} })
		try {
			assert.equal((await modules.readNetworkSnapshot(owner)).simulation.kind, 'unavailable')
			assert.equal(await modules.readNetworkSnapshotForServices(replacedServices), undefined)
			await assert.rejects(modules.readNetworkSnapshot({ getCurrent: () => replacedServices }), /no longer serve the active network/u)
			// Pending replies retain the weaker read even while no coherent pairing can be admitted.
			const pending = await modules.readNetworkSnapshotForPendingRequest({ getCurrent: () => replacedServices })
			assert.equal(pending.settings.activeRpcNetwork.chainId, networkA.chainId)
			assert.equal(pending.services.ethereum, replacedServices.ethereum)
			assert.equal(pending.simulation.kind, 'unavailable')
			assert.equal('readUnderNetworkLock' in pending, false)
		} finally {
			Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet })
			retireAll()
			replacedServices.ethereum.cleanup()
		}
	})

test('a read for services of another network returns no snapshot, and a read for the active network simulates on its own client', async () => {
		const { modules } = await createApprovedSimulationDapp()
		const { getSimulationProviderForSnapshot, getUpdatedSimulationState, requireSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		await modules.updateInterceptorTransactionStack(() => ({ operations: [createStackedTransaction(1n, networkA.chainId, STACKED_ON_A_RECIPIENT)] }))
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const otherChainServices = createNetworkServices(networkB)
		const otherEndpointServices = createNetworkServices(networkAOnOtherEndpoint)
		try {
			for (const services of [otherChainServices, otherEndpointServices]) {
				assert.equal(await modules.readNetworkSnapshotForServices(services), undefined)
				await assert.rejects(modules.readNetworkSnapshot({ getCurrent: () => services }), /no longer serve the active network/u)
				assert.deepEqual(services.requests, [])
			}
			const ownServices = getInstalled()
			const snapshot = requireSimulationSnapshot((await modules.readNetworkSnapshot(owner)).simulation)
			assert.equal(getSimulationProviderForSnapshot(snapshot), ownServices.ethereum)
			assert.equal((await getUpdatedSimulationState(snapshot)).kind, 'simulated')
			assert.ok(getSimulatedCallRecipients(ownServices).includes(STACKED_ON_A_RECIPIENT))
		} finally {
			retireAll()
			otherChainServices.ethereum.cleanup()
			otherEndpointServices.ethereum.cleanup()
		}
	})

test('rich-address settings wait for the network and use the services captured with them', async () => {
		const dapp = await createApprovedSimulationDapp()
		const { modules } = dapp
		const unknownAddress = 0x4545454545454545454545454545454545454545n
		await modules.setFixedMakeMeRichList([{ address: unknownAddress, makingRich: false, type: 'UserAdded' }])
		const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
		const servicesA = getInstalled()
		const context = await dapp.createPopupContext(owner)
		const paused = pauseAfterActiveNetworkWrite()
		const switching = dapp.switchToNetworkB(owner)
		let requested: Promise<unknown> | undefined
		try {
			await paused.written
			const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
			requested = dispatchPopupMessage(context, { method: 'popup_requestMakeMeRichData' })
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(servicesA.requests, [])
			paused.release()
			await Promise.all([switching, requested])
			assert.equal(getInstalled().ethereum.getChainId(), networkB.chainId)
			assert.deepEqual(servicesA.requests, [])
			assert.ok(getInstalled().requests.some((request) => request.method === 'eth_getCode'))
		} finally {
			paused.release()
			await Promise.allSettled([switching, requested])
			retireAll()
		}
	})

test('returning to an endpoint never admits a retired client from its previous installation', async () => {
	const { modules } = await createApprovedSimulationDapp()
	const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
	const previousA = getInstalled()
	try {
		await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
		await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: false, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
		assert.equal(previousA.ethereum.isRetired(), true)
		assert.notEqual(getInstalled().ethereum, previousA.ethereum)
		assert.equal(await modules.readNetworkSnapshotForServices(previousA), undefined)
		await assert.rejects(modules.readNetworkSnapshot({ getCurrent: () => previousA }), /no longer serve the active network/)
		const current = await modules.readNetworkSnapshot(owner)
		assert.equal(current.services.ethereum, getInstalled().ethereum)
		const pending = await modules.readNetworkSnapshotForPendingRequest({ getCurrent: () => previousA })
		assert.equal(pending.simulation.kind, 'replaced')
		assert.equal('readUnderNetworkLock' in pending, false)
	} finally {
		retireAll()
	}
})

test('a rejected settings write runs no transition callback or repair effects', async () => {
	installBrowserMock()
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: networkA })
	const { owner, getInstalled, retireAll } = createRecordingServicesOwner(networkA)
	const installed = getInstalled()
	const failure = new Error('Settings persistence failed')
	let callbacks = 0
	try {
		await assert.rejects(modules.runSettingsTransition(owner, new Map(), {
			writeSettings: async () => { throw failure },
			afterNetworkApplied: async () => { callbacks += 1 },
		}), (error) => error === failure)
		await modules.readNetworkSnapshot(owner)
		assert.equal(callbacks, 0)
		assert.equal(getInstalled(), installed)
		assert.equal((await modules.getSettings()).activeRpcNetwork.chainId, networkA.chainId)
	} finally {
		retireAll()
	}
})
