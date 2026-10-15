import * as assert from 'node:assert'
import { describe, expect, test } from 'bun:test'
import type { ContactEntry, SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { TabConnection, WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { ICON_NOT_ACTIVE } from '../../app/ts/utils/constants.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { ActiveAddressSelection } from '../../app/ts/utils/activeAddressSelection.js'
import { flushMicrotasks, settleWithin } from '../harness/async.js'
import { type BackgroundBrowserMock, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const isRuntimeMessage = (method: string) => (message: unknown) => hasMessageMethod(message, method)

const firstAddress: ContactEntry = { type: 'contact', name: 'First address', address: 1n, chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false }
const secondAddress: ContactEntry = { ...firstAddress, name: 'Second address', address: 2n }

// Yield after persistence so the next transition can attempt to overtake unfinished side effects.
function pauseAfterFirstStorageWrite(browserMock: BackgroundBrowserMock, key: string) {
	const started = Promise.withResolvers<void>()
	const localStorage = browserMock.browser.storage.local
	const writeLocalStorage = localStorage.set
	let paused = false
	localStorage.set = async (items) => {
		await writeLocalStorage(items)
		if (paused || !(key in items)) return
		paused = true
		started.resolve()
		await flushMicrotasks()
	}
	return started.promise
}

describe('active settings concurrency', () => {
	test('publishes concurrent network transitions in persisted order', async () => {
		const browserMock = installBrowserMock()
		const { changeActiveAddressAndChain, getSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		await updateUserAddressBookEntries(() => [firstAddress, secondAddress])
		const websiteOrigin = 'example.test'
		await updateWebsiteAccess(() => [{ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, addressAccess: undefined }])
		const { port, messages } = createPort(1)
		const socket = { tabId: 1, connectionName: 0n }
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const firstRpcWriteStarted = pauseAfterFirstStorageWrite(browserMock, 'activeRpcNetwork')
		const previousNetwork = (await getSettings()).activeRpcNetwork
		const firstNetwork = {
			...previousNetwork,
			name: 'First network',
			chainId: 10n,
			httpsRpc: 'https://first.invalid',
			primary: false,
		} satisfies RpcEntry
		const secondNetwork = {
			...previousNetwork,
			name: 'Second network',
			chainId: 42161n,
			httpsRpc: 'https://second.invalid',
			primary: false,
		} satisfies RpcEntry
		const resetNetworks: RpcEntry[] = []
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const simulationServicesOwner = createTestSimulationServicesOwner({ ethereum, tokenPriceService }, network => { resetNetworks.push(network); return { ethereum, tokenPriceService } })

		const firstTransition = changeActiveAddressAndChain(simulationServicesOwner, connections, {
			simulationMode: true,
			rpcNetwork: firstNetwork,
			activeAddress: firstAddress.address,
			promptForAccessesIfNeeded: false,
		})
		await firstRpcWriteStarted
		const secondTransition = changeActiveAddressAndChain(simulationServicesOwner, connections, {
			simulationMode: true,
			rpcNetwork: secondNetwork,
			activeAddress: secondAddress.address,
			promptForAccessesIfNeeded: false,
		})
		await Promise.all([firstTransition, secondTransition])

		expect(messages.filter(({ method }) => method === 'chainChanged' || method === 'accountsChanged').map(({ method, result }) => ({ method, result }))).toEqual([
			{ method: 'chainChanged', result: '0xa' },
			{ method: 'accountsChanged', result: ['0x0000000000000000000000000000000000000001'] },
			{ method: 'chainChanged', result: '0xa4b1' },
			{ method: 'accountsChanged', result: ['0x0000000000000000000000000000000000000002'] },
		])
		assert.deepEqual(resetNetworks.map((network) => network.chainId), [firstNetwork.chainId, secondNetwork.chainId])
		assert.equal((await getSettings()).activeRpcNetwork.chainId, secondNetwork.chainId)
	})

	test('a selection queued behind an endpoint reset uses the installed services', async () => {
		const browserMock = installBrowserMock()
		const { activateAddressSelection, changeActiveAddressAndChain, getSettings } = await loadModules()
		const original = createEthereumWithGetBlockCounter({ count: 0 })
		const installed = createEthereumWithGetBlockCounter({ count: 0 })
		const owner = createTestSimulationServicesOwner(original, () => installed)
		let oldReads = 0
		let installedReads = 0
		original.ethereum.getCachedBlock = () => { oldReads++; return undefined }
		installed.ethereum.getCachedBlock = () => { installedReads++; return undefined }
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let held = false
		browserMock.handlers.runtimeMessage = async (message) => {
			if (!held && isRuntimeMessage('popup_settingsUpdated')(message)) {
				held = true
				entered.resolve()
				await release.promise
			}
			return undefined
		}
		const rpcNetwork = { ...(await getSettings()).activeRpcNetwork, httpsRpc: 'https://installed.example' }
		const safe: SafeEntry = { type: 'safe', name: 'Queued Safe', address: 3n, chainId: rpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [firstAddress.address] }
		const first = changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork })
		try {
			await entered.promise
			const second = activateAddressSelection(owner, new Map(), { type: 'addressBookEntry', entry: safe }, { simulationMode: false, signerAddress: firstAddress.address, promptForAccessesIfNeeded: false })
			release.resolve()
			await Promise.all([first, second])
			assert.equal(oldReads, 0)
			assert.equal(installedReads, 2)
		} finally {
			release.resolve()
			await first
		}
	})

	test.each([true, false])('keeps concurrent simulation selections consistent when selecting signer first: %j', async (signerFirst) => {
		const browserMock = installBrowserMock()
		const { activateAddressSelection, getSettings } = await loadModules()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const signerSelection: ActiveAddressSelection = { type: 'signer', address: firstAddress.address }
		const addressSelection: ActiveAddressSelection = { type: 'addressBookEntry', entry: secondAddress }
		const firstWriteStarted = pauseAfterFirstStorageWrite(browserMock, 'useSignersAddressAsActiveAddress')
		const options = { simulationMode: true, signerAddress: firstAddress.address, promptForAccessesIfNeeded: false }
		const first = activateAddressSelection(createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })), new Map(), signerFirst ? signerSelection : addressSelection, options)
		await firstWriteStarted
		const second = activateAddressSelection(createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })), new Map(), signerFirst ? addressSelection : signerSelection, options)
		await Promise.all([first, second])

		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, signerFirst ? secondAddress.address : firstAddress.address)
		assert.equal(settings.useSignersAddressAsActiveAddress, !signerFirst)
	})

	test.each([true, false])('remembers the final concurrent signing selection when selecting Safe first: %j', async (safeFirst) => {
		const browserMock = installBrowserMock()
		const { activateAddressSelection, getSettings, getSigningAddressPreferences, updateUserAddressBookEntries } = await loadModules()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const safe: SafeEntry = { type: 'safe', name: 'Owned Safe', address: 3n, chainId: (await getSettings()).activeRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [firstAddress.address] }
		await updateUserAddressBookEntries(() => [firstAddress, safe])
		const signerSelection: ActiveAddressSelection = { type: 'signer', address: firstAddress.address }
		const safeSelection: ActiveAddressSelection = { type: 'addressBookEntry', entry: safe }
		const firstWriteStarted = pauseAfterFirstStorageWrite(browserMock, 'activeSigningSafeAddress')
		const options = { simulationMode: false, signerAddress: firstAddress.address, promptForAccessesIfNeeded: false }
		const first = activateAddressSelection(createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })), new Map(), safeFirst ? safeSelection : signerSelection, options)
		await firstWriteStarted
		const second = activateAddressSelection(createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })), new Map(), safeFirst ? signerSelection : safeSelection, options)
		await Promise.all([first, second])

		assert.equal((await getSettings()).activeSigningSafeAddress, safeFirst ? undefined : safe.address)
		expect(await getSigningAddressPreferences()).toEqual([safeFirst
			? { signerAddress: firstAddress.address, selection: 'signer' }
			: { signerAddress: firstAddress.address, selection: 'safe', safeAddress: safe.address, chainId: safe.chainId },
		])
	})

	test.each(['signing preference', 'stack storage', 'settings broadcast'])('preserves visualization when %s fails', async (failurePoint) => {
		const browserMock = installBrowserMock()
		const { runtimeMessages } = browserMock
		const { activateAddressSelection, getSettings } = await loadModules()
		const { getPopupVisualisationState, setPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
		const { getLatestUnexpectedError } = await import('../../app/ts/utils/unexpectedErrorStorage.js')
		const previousVisualisation = { ...await getPopupVisualisationState(), simulationId: 42 }
		await setPopupVisualisationState(previousVisualisation)
		const localStorage = browserMock.browser.storage.local
		const writeLocalStorage = localStorage.set
		const failure = new Error(`Injected ${ failurePoint } failure`)
		localStorage.set = async (items) => {
			if (failurePoint === 'signing preference' && 'signingAddressPreferences' in items) throw failure
			if (failurePoint === 'stack storage' && 'interceptorTransactionStack' in items) throw failure
			await writeLocalStorage(items)
		}
		browserMock.handlers.runtimeMessage = (message) => {
			if (failurePoint === 'settings broadcast' && isRuntimeMessage('popup_settingsUpdated')(message)) throw failure
			return undefined
		}
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		const network = (await getSettings()).activeRpcNetwork
		const transition = activateAddressSelection(createTestSimulationServicesOwner(services), new Map(), { type: 'signer', address: firstAddress.address }, {
			simulationMode: failurePoint === 'stack storage', signerAddress: firstAddress.address, promptForAccessesIfNeeded: false,
			...(failurePoint === 'stack storage' ? { rpcNetwork: { ...network, chainId: network.chainId + 1n } } : {}),
		})
		if (failurePoint === 'settings broadcast') {
			// Broadcast failures already belong to the unexpected-error reporter.
			await transition
			assert.equal((await getLatestUnexpectedError())?.data.message, failure.message)
		} else {
			await assert.rejects(transition, error => error === failure)
			assert.equal(runtimeMessages.some(isRuntimeMessage('popup_settingsUpdated')), true)
		}
		assert.deepEqual(await getPopupVisualisationState(), previousVisualisation)
		assert.equal(runtimeMessages.some(isRuntimeMessage('popup_simulation_state_changed')), false)
	})

	test('retains committed Safe preferences and invalidates the popup after provider reset failure', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { activateAddressSelection, getSettings, getSigningAddressPreferences, updateUserAddressBookEntries } = await loadModules()
		const { getPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
		const safe: SafeEntry = { type: 'safe', name: 'Owned Safe', address: 3n, chainId: (await getSettings()).activeRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [firstAddress.address] }
		await updateUserAddressBookEntries(() => [firstAddress, safe])
		const counter = { count: 0 }
		const services = createEthereumWithGetBlockCounter(counter)
		const rpcNetwork = { ...(await getSettings()).activeRpcNetwork, httpsRpc: 'https://failed-install.example' }
		const failure = new Error('Injected provider reset failure')
		await assert.rejects(activateAddressSelection(createTestSimulationServicesOwner({ ethereum: services.ethereum, tokenPriceService: services.tokenPriceService }, () => { throw failure }), new Map(), { type: 'addressBookEntry', entry: safe }, {
			simulationMode: false, signerAddress: firstAddress.address, rpcNetwork, promptForAccessesIfNeeded: false,
		}), error => error === failure)
		assert.equal((await getSettings()).activeSigningSafeAddress, safe.address)
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress: firstAddress.address, selection: 'safe', safeAddress: safe.address, chainId: safe.chainId }])
		const visualisation = await getPopupVisualisationState()
		assert.equal(visualisation.simulationUpdatingState, 'failed')
		assert.equal(visualisation.simulationResultState, 'invalid')
		assert.equal(visualisation.simulationState.kind, 'passthrough')
		assert.equal(counter.count, 0, 'Failure handling must not simulate on the old provider')
		assert.equal(runtimeMessages.some(isRuntimeMessage('popup_simulation_state_changed')), true)
		assert.equal(runtimeMessages.some(isRuntimeMessage('popup_settingsUpdated')), true)
	})

	test('settles an address change that prompts for access alongside an approval that selects another address', async () => {
		const browserMock = installBrowserMock()
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings, updateUserAddressBookEntries, websiteSocketToString, requestAccessFromUser, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const originalAddress = { ...firstAddress, askForAddressAccess: true }
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [originalAddress, selectedAddress])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: originalAddress.address })
		const websiteOrigin = 'example.test'
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await requestAccessFromUser(connections, socket, { websiteOrigin, icon: undefined, title: undefined }, undefined, originalAddress, await getSettings(), originalAddress, undefined)
		const pending = (await getPendingAccessRequests())[0]
		if (pending === undefined) throw new Error('Missing pending access request')

		const approvalHasDialogLock = Promise.withResolvers<void>()
		const releaseApproval = Promise.withResolvers<void>()
		const localStorage = browserMock.browser.storage.local
		const readLocalStorage = localStorage.get
		let paused = false
		localStorage.get = async (keys) => {
			const result = await readLocalStorage(keys)
			if (!paused && Array.isArray(keys) && keys.includes('pendingInterceptorAccessRequests')) {
				paused = true
				approvalHasDialogLock.resolve()
				await releaseApproval.promise
			}
			return result
		}
		const approval = resolveInterceptorAccess(simulationServicesOwner, connections, {
			userReply: 'Approved',
			accessRequestId: pending.accessRequestId,
			originalRequestAccessToAddress: originalAddress.address,
			requestAccessToAddress: selectedAddress.address,
		}, noopPublishRpcConnectionStatus)
		await approvalHasDialogLock.promise
		const transitionStarted = pauseAfterFirstStorageWrite(browserMock, 'independentActiveSimulationAddress')
		const transition = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: originalAddress.address })
		await transitionStarted
		// Let the transition reach access prompting while the approval still owns the dialog lock.
		await flushMicrotasks()
		releaseApproval.resolve()
		await settleWithin(Promise.all([approval, transition]), 1000, 'Active settings and access approval deadlocked')
		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, selectedAddress.address)
		const access = settings.websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		expect(access?.addressAccess).toEqual([{ address: selectedAddress.address, access: true }])
		expect(await getPendingAccessRequests()).toEqual([])
	})

	test.each(['direct', 'selection'])('reports a failed access prompt without rejecting a persisted %s address change', async (entryPoint) => {
		const browserMock = installBrowserMock()
		const { activateAddressSelection, changeActiveAddressAndChain, getSettings, getLatestUnexpectedError, updateUserAddressBookEntries, websiteSocketToString, syncWebsiteApprovalsWithSettings } = await loadModules()
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [selectedAddress])
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: true },
		} }]])
		browserMock.browser.windows.create = async () => { throw new Error('Access popup failed to open') }
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		if (entryPoint === 'direct') {
			await changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: selectedAddress.address })
		} else {
			await activateAddressSelection(simulationServicesOwner, connections, { type: 'addressBookEntry', entry: selectedAddress }, { simulationMode: true, signerAddress: undefined })
		}
		assert.equal((await getSettings()).activeSimulationAddress, selectedAddress.address)
		assert.equal((await getLatestUnexpectedError())?.data.message, 'Access popup failed to open')
		await assert.rejects(syncWebsiteApprovalsWithSettings(connections, { promptForAccessesIfNeeded: true, throwOnError: true }), /Access popup failed to open/u)
	})

	test.each([1, 2])('continues prompting after a failure when the next connection is in tab %j', async (secondTabId) => {
		const browserMock = installBrowserMock()
		const { changeActiveAddressAndChain, getLatestUnexpectedError, updateUserAddressBookEntries, websiteSocketToString, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [selectedAddress])
		const connections: WebsiteTabConnections = new Map()
		for (const { tabId, connectionName, websiteOrigin } of [{ tabId: 1, connectionName: 0n, websiteOrigin: 'first.test' }, { tabId: secondTabId, connectionName: 1n, websiteOrigin: 'second.test' }]) {
			const socket = { tabId, connectionName }
			const { port } = createPort(tabId, undefined, undefined, connectionName)
			const tab: TabConnection = connections.get(tabId) ?? { connections: {} }
			tab.connections[websiteSocketToString(socket)] = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
			connections.set(tabId, tab)
		}
		const createWindow = browserMock.browser.windows.create
		let promptAttempts = 0
		browserMock.browser.windows.create = async (createData) => {
			promptAttempts += 1
			if (promptAttempts === 1) throw new Error('First connection prompt failed')
			return await createWindow(createData)
		}
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: selectedAddress.address })
		const pending = await getPendingAccessRequests()
		try {
			assert.equal(promptAttempts, 2)
			assert.equal((await getLatestUnexpectedError())?.data.message, 'First connection prompt failed')
			expect(pending.map((request) => request.website.websiteOrigin)).toEqual(['second.test'])
		} finally {
			// Close the successful prompt so the shared dialog state cannot leak into another test.
			for (const request of pending) {
				await resolveInterceptorAccess(simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})

	test('a slow icon refresh does not block the next address change or leave stale toolbar state', async () => {
		const browserMock = installBrowserMock()
		const { changeActiveAddressAndChain, getSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString, getTabState } = await loadModules()
		await updateUserAddressBookEntries(() => [firstAddress, { ...secondAddress, askForAddressAccess: true }])
		const websiteOrigin = 'example.test'
		await updateWebsiteAccess(() => [{ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, addressAccess: undefined }])
		const secondAccountPublished = Promise.withResolvers<void>()
		const { port } = createPort(1, (message) => {
			if (message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length === 0) secondAccountPublished.resolve()
		})
		const socket = { tabId: 1, connectionName: 0n }
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const iconStarted = Promise.withResolvers<void>()
		const releaseIcon = Promise.withResolvers<void>()
		const toolbar = browserMock.browser.action
		const setToolbarIcon = toolbar.setIcon
		let paused = false
		toolbar.setIcon = async (details) => {
			if (!paused) {
				paused = true
				iconStarted.resolve()
				await releaseIcon.promise
			}
			await setToolbarIcon(details)
		}
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const first = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: firstAddress.address, promptForAccessesIfNeeded: false })
		await iconStarted.promise
		const second = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: secondAddress.address, promptForAccessesIfNeeded: false })
		try {
			await settleWithin(secondAccountPublished.promise, 1000, 'Icon refresh blocked the next settings transition')
			assert.equal((await getSettings()).activeSimulationAddress, secondAddress.address)
			// Let any unqueued second icon update finish before the first browser call resumes.
			await flushMicrotasks()
		} finally {
			releaseIcon.resolve()
			await Promise.all([first, second])
		}
		// The paused first icon call is recorded when it resumes, so the recorded order is the order in which the browser applied the updates.
		const lastIcon = browserMock.calls.action.flatMap((call) => call.method === 'setIcon' ? [call.details.path] : []).at(-1)
		const lastTitle = browserMock.calls.action.flatMap((call) => call.method === 'setTitle' ? [call.details.title] : []).at(-1)
		const expectedTitle = 'example.test has PENDING access request for Second address!'
		expect(lastIcon).toEqual({ 128: ICON_NOT_ACTIVE })
		assert.equal(lastTitle, expectedTitle)
		expect((await getTabState(1)).tabIconDetails).toEqual({ icon: ICON_NOT_ACTIVE, iconReason: expectedTitle })
	})

	test.each(['immediate', 'staged'])('%s access updates prompt for the latest address rather than the reconciliation snapshot', async (completion) => {
		installBrowserMock()
		const { changeSimulationMode, updateUserAddressBookEntries, websiteSocketToString, reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate, syncWebsiteApprovalsWithSettings, withSettingsTransitionLock, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const originalAddress = { ...firstAddress, askForAddressAccess: true }
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [originalAddress, selectedAddress])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: originalAddress.address })
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(1)
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		if (completion === 'staged') {
			const update = await withSettingsTransitionLock(async (lock) => await reconcileWebsiteApprovalAccesses(connections, await lock.readSettings()))
			await changeSimulationMode({ simulationMode: true, activeSimulationAddress: selectedAddress.address })
			await finishWebsiteAccessUpdate(connections, update, { promptForAccessesIfNeeded: true })
		} else {
			await changeSimulationMode({ simulationMode: true, activeSimulationAddress: selectedAddress.address })
			await syncWebsiteApprovalsWithSettings(connections, { promptForAccessesIfNeeded: true })
		}
		const pending = await getPendingAccessRequests()
		try {
			expect(pending.map((request) => request.requestAccessToAddress?.address)).toEqual([selectedAddress.address])
		} finally {
			for (const request of pending) {
				await resolveInterceptorAccess(simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})

	test('website approval sync waits for an in-flight settings transition and reconciles its committed address', async () => {
		const browserMock = installBrowserMock()
		const { changeActiveAddressAndChain, changeSimulationMode, syncWebsiteApprovalsWithSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		const approvedAddress = { ...firstAddress, askForAddressAccess: true }
		const unapprovedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [approvedAddress, unapprovedAddress])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: approvedAddress.address })
		const website = { websiteOrigin: 'example.test', icon: undefined, title: undefined }
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: approvedAddress.address, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true }
		const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		// Hold the transition inside the settings lock right after it stores the new address.
		const transitionHoldsLock = Promise.withResolvers<void>()
		const releaseTransition = Promise.withResolvers<void>()
		const localStorage = browserMock.browser.storage.local
		const writeLocalStorage = localStorage.set
		let held = false
		localStorage.set = async (items) => {
			await writeLocalStorage(items)
			if (held || !('independentActiveSimulationAddress' in items)) return
			held = true
			transitionHoldsLock.resolve()
			await releaseTransition.promise
		}
		try {
			const transition = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: unapprovedAddress.address, promptForAccessesIfNeeded: false })
			await transitionHoldsLock.promise
			let syncFinished = false
			const sync = syncWebsiteApprovalsWithSettings(connections, { promptForAccessesIfNeeded: false }).then(() => { syncFinished = true })
			await flushMicrotasks()
			assert.equal(syncFinished, false, 'Website approval sync must wait for the settings transition lock')
			releaseTransition.resolve()
			await Promise.all([transition, sync])
		} finally {
			releaseTransition.resolve()
		}
		// The newly active address has no access, so neither reconciliation may leave the port approved.
		assert.equal(connection.approved, false)
	})

	test('rejects an invalid signing selection before changing stored settings', async () => {
		const browserMock = installBrowserMock()
		const { activateAddressSelection } = await loadModules()
		const before = browserMock.readStorage()
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await assert.rejects(activateAddressSelection(simulationServicesOwner, new Map(), { type: 'addressBookEntry', entry: secondAddress }, {
			simulationMode: false, signerAddress: firstAddress.address,
		}), /Signing mode can only activate the external signer or an owned Gnosis Safe/u)
		expect(browserMock.readStorage()).toEqual(before)
	})

	test.each(['direct', 'selection'])('completes access UI after a persisted %s transition throws', async (entryPoint) => {
		installBrowserMock()
		const { activateAddressSelection, changeActiveAddressAndChain, getSettings, getTabState, updateUserAddressBookEntries, websiteSocketToString, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [selectedAddress])
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(1)
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const rpcNetwork = { ...(await getSettings()).activeRpcNetwork, httpsRpc: 'https://replacement.invalid' }
		const failure = new Error('Service reset failed after settings persisted')
		const failReset = createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => { throw failure })
		const transition = entryPoint === 'direct'
			? changeActiveAddressAndChain(failReset, connections, { simulationMode: true, activeAddress: selectedAddress.address, rpcNetwork })
			: activateAddressSelection(failReset, connections, { type: 'addressBookEntry', entry: selectedAddress }, { simulationMode: true, signerAddress: undefined, rpcNetwork })
		await assert.rejects(transition, (error: unknown) => error === failure)
		const pending = await getPendingAccessRequests()
		try {
			assert.equal((await getSettings()).activeSimulationAddress, selectedAddress.address)
			expect(pending.map((request) => request.requestAccessToAddress?.address)).toEqual([selectedAddress.address])
			expect((await getTabState(1)).tabIconDetails).toEqual({ icon: ICON_NOT_ACTIVE, iconReason: 'example.test has PENDING access request for Second address!' })
		} finally {
			for (const request of pending) {
				await resolveInterceptorAccess(simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})
})
