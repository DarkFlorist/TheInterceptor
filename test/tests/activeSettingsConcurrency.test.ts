import * as assert from 'node:assert'
import { describe, expect, test } from 'bun:test'
import type { ContactEntry, SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { TabConnection, WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { ICON_NOT_ACTIVE } from '../../app/ts/utils/constants.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { createTestSimulationServicesOwner, createDeferredSignal, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const firstAddress: ContactEntry = { type: 'contact', name: 'First address', address: 1n, chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false }
const secondAddress: ContactEntry = { ...firstAddress, name: 'Second address', address: 2n }

// Yield after persistence so the next transition can attempt to overtake unfinished side effects.
function pauseAfterFirstStorageWrite(key: string) {
	const started = createDeferredSignal()
	const originalSet = browser.storage.local.set.bind(browser.storage.local)
	let paused = false
	Object.defineProperty(browser.storage.local, 'set', {
		configurable: true,
		value: async (items: object) => {
			await originalSet(items)
			if (paused || !(key in items)) return
			paused = true
			started.resolve()
			await new Promise((resolve) => setTimeout(resolve, 0))
		},
	})
	return started.promise
}

describe('active settings concurrency', () => {
	test('publishes concurrent network transitions in persisted order', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, getSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		await updateUserAddressBookEntries(() => [firstAddress, secondAddress])
		const websiteOrigin = 'example.test'
		await updateWebsiteAccess(() => [{ website: { websiteOrigin }, access: true }])
		const { port, messages } = createPort(1)
		const socket = { tabId: 1, connectionName: 0n }
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const firstRpcWriteStarted = pauseAfterFirstStorageWrite('activeRpcNetwork')
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
		installBrowserMock()
		const { activateAddressSelection, changeActiveAddressAndChain, getSettings } = await loadModules()
		const original = createEthereumWithGetBlockCounter({ count: 0 })
		const installed = createEthereumWithGetBlockCounter({ count: 0 })
		const owner = createTestSimulationServicesOwner(original, () => installed)
		let oldReads = 0
		let installedReads = 0
		original.ethereum.getCachedBlock = () => { oldReads++; return undefined }
		installed.ethereum.getCachedBlock = () => { installedReads++; return undefined }
		const entered = createDeferredSignal()
		const release = createDeferredSignal()
		const originalSend = browser.runtime.sendMessage
		let held = false
		browser.runtime.sendMessage = async message => {
			if (!held && typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_settingsUpdated') {
				held = true
				entered.resolve()
				await release.promise
			}
			return await originalSend(message)
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
			browser.runtime.sendMessage = originalSend
		}
	})

	test.each([true, false])('keeps concurrent simulation selections consistent when selecting signer first: %j', async (signerFirst) => {
		installBrowserMock()
		const { activateAddressSelection, getSettings } = await loadModules()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const signerSelection = { type: 'signer', address: firstAddress.address } as const
		const addressSelection = { type: 'addressBookEntry', entry: secondAddress } as const
		const firstWriteStarted = pauseAfterFirstStorageWrite('useSignersAddressAsActiveAddress')
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
		installBrowserMock()
		const { activateAddressSelection, getSettings, getSigningAddressPreferences, updateUserAddressBookEntries } = await loadModules()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const safe: SafeEntry = { type: 'safe', name: 'Owned Safe', address: 3n, chainId: (await getSettings()).activeRpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [firstAddress.address] }
		await updateUserAddressBookEntries(() => [firstAddress, safe])
		const signerSelection = { type: 'signer', address: firstAddress.address } as const
		const safeSelection = { type: 'addressBookEntry', entry: safe } as const
		const firstWriteStarted = pauseAfterFirstStorageWrite('activeSigningSafeAddress')
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
		assert.equal(runtimeMessages.some(message => message.method === 'popup_simulation_state_changed'), true)
		assert.equal(runtimeMessages.some(message => message.method === 'popup_settingsUpdated'), true)
	})

	test('settles an address change that prompts for access alongside an approval that selects another address', async () => {
		installBrowserMock()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await requestAccessFromUser(ethereum, tokenPriceService, simulationServicesOwner, connections, socket, { websiteOrigin }, undefined, originalAddress, await getSettings(), originalAddress, undefined)
		const pending = (await getPendingAccessRequests())[0]
		if (pending === undefined) throw new Error('Missing pending access request')

		const approvalHasDialogLock = createDeferredSignal()
		const releaseApproval = createDeferredSignal()
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		let paused = false
		Object.defineProperty(browser.storage.local, 'get', {
			configurable: true,
			value: async (...args: Parameters<typeof browser.storage.local.get>) => {
				const result = await originalGet(...args)
				const keys = args[0]
				if (!paused && Array.isArray(keys) && keys.includes('pendingInterceptorAccessRequests')) {
					paused = true
					approvalHasDialogLock.resolve()
					await releaseApproval.promise
				}
				return result
			},
		})
		const approval = resolveInterceptorAccess(ethereum, tokenPriceService, simulationServicesOwner, connections, {
			userReply: 'Approved',
			accessRequestId: pending.accessRequestId,
			originalRequestAccessToAddress: originalAddress.address,
			requestAccessToAddress: selectedAddress.address,
		}, noopPublishRpcConnectionStatus)
		await approvalHasDialogLock.promise
		const transitionStarted = pauseAfterFirstStorageWrite('independentActiveSimulationAddress')
		const transition = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: originalAddress.address })
		await transitionStarted
		// Let the transition reach access prompting while the approval still owns the dialog lock.
		await new Promise((resolve) => setTimeout(resolve, 0))
		releaseApproval.resolve()
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				Promise.all([approval, transition]),
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Active settings and access approval deadlocked')), 1000) }),
			])
		} finally {
			clearTimeout(timeout)
			Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet })
		}
		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, selectedAddress.address)
		const access = settings.websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		expect(access?.addressAccess).toEqual([{ address: selectedAddress.address, access: true }])
		expect(await getPendingAccessRequests()).toEqual([])
	})

	test.each(['direct', 'selection'])('reports a failed access prompt without rejecting a persisted %s address change', async (entryPoint) => {
		installBrowserMock()
		const { activateAddressSelection, changeActiveAddressAndChain, getSettings, getLatestUnexpectedError, updateUserAddressBookEntries, websiteSocketToString, updateWebsiteApprovalAccesses } = await loadModules()
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [selectedAddress])
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: true },
		} }]])
		Object.defineProperty(browser.windows, 'create', {
			configurable: true,
			value: async () => { throw new Error('Access popup failed to open') },
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		if (entryPoint === 'direct') {
			await changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: selectedAddress.address })
		} else {
			await activateAddressSelection(simulationServicesOwner, connections, { type: 'addressBookEntry', entry: selectedAddress }, { simulationMode: true, signerAddress: undefined })
		}
		assert.equal((await getSettings()).activeSimulationAddress, selectedAddress.address)
		assert.equal((await getLatestUnexpectedError())?.data.message, 'Access popup failed to open')
		await assert.rejects(updateWebsiteApprovalAccesses(ethereum, tokenPriceService, simulationServicesOwner, connections, await getSettings(), true, true), /Access popup failed to open/u)
	})

	test.each([1, 2])('continues prompting after a failure when the next connection is in tab %j', async (secondTabId) => {
		installBrowserMock()
		const { changeActiveAddressAndChain, getLatestUnexpectedError, updateUserAddressBookEntries, websiteSocketToString, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [selectedAddress])
		const connections: WebsiteTabConnections = new Map()
		for (const [tabId, connectionName, websiteOrigin] of [[1, 0n, 'first.test'], [secondTabId, 1n, 'second.test']] as const) {
			const socket = { tabId, connectionName }
			const { port } = createPort(tabId, undefined, undefined, connectionName)
			const tab: TabConnection = connections.get(tabId) ?? { connections: {} }
			tab.connections[websiteSocketToString(socket)] = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
			connections.set(tabId, tab)
		}
		const originalCreate = browser.windows.create.bind(browser.windows)
		let promptAttempts = 0
		Object.defineProperty(browser.windows, 'create', {
			configurable: true,
			value: async (...args: Parameters<typeof browser.windows.create>) => {
				promptAttempts += 1
				if (promptAttempts === 1) throw new Error('First connection prompt failed')
				return await originalCreate(...args)
			},
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: selectedAddress.address })
		const pending = await getPendingAccessRequests()
		try {
			assert.equal(promptAttempts, 2)
			assert.equal((await getLatestUnexpectedError())?.data.message, 'First connection prompt failed')
			expect(pending.map((request) => request.website.websiteOrigin)).toEqual(['second.test'])
		} finally {
			// Close the successful prompt so the shared dialog state cannot leak into another test.
			for (const request of pending) {
				await resolveInterceptorAccess(ethereum, tokenPriceService, simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})

	test('a slow icon refresh does not block the next address change or leave stale toolbar state', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, getSettings, updateUserAddressBookEntries, updateWebsiteAccess, websiteSocketToString, getTabState } = await loadModules()
		await updateUserAddressBookEntries(() => [firstAddress, { ...secondAddress, askForAddressAccess: true }])
		const websiteOrigin = 'example.test'
		await updateWebsiteAccess(() => [{ website: { websiteOrigin }, access: true }])
		const secondAccountPublished = createDeferredSignal()
		const { port } = createPort(1, (message) => {
			if (message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length === 0) secondAccountPublished.resolve()
		})
		const socket = { tabId: 1, connectionName: 0n }
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const iconStarted = createDeferredSignal()
		const releaseIcon = createDeferredSignal()
		const originalSetIcon = browser.action.setIcon.bind(browser.action)
		let lastIcon: unknown
		let lastTitle: string | undefined
		Object.defineProperty(browser.action, 'setTitle', {
			configurable: true,
			value: async (details: Parameters<typeof browser.action.setTitle>[0]) => { lastTitle = details.title },
		})
		let paused = false
		Object.defineProperty(browser.action, 'setIcon', {
			configurable: true,
			value: async (...args: Parameters<typeof browser.action.setIcon>) => {
				if (!paused) {
					paused = true
					iconStarted.resolve()
					await releaseIcon.promise
				}
				lastIcon = args[0].path
				return await originalSetIcon(...args)
			},
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const first = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: firstAddress.address, promptForAccessesIfNeeded: false })
		await iconStarted.promise
		const second = changeActiveAddressAndChain(simulationServicesOwner, connections, { simulationMode: true, activeAddress: secondAddress.address, promptForAccessesIfNeeded: false })
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				secondAccountPublished.promise,
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Icon refresh blocked the next settings transition')), 1000) }),
			])
			assert.equal((await getSettings()).activeSimulationAddress, secondAddress.address)
			// Let any unqueued second icon update finish before the first browser call resumes.
			await new Promise((resolve) => setTimeout(resolve, 0))
		} finally {
			clearTimeout(timeout)
			releaseIcon.resolve()
			await Promise.all([first, second])
		}
		const expectedTitle = 'example.test has PENDING access request for Second address!'
		expect(lastIcon).toEqual({ 128: ICON_NOT_ACTIVE })
		assert.equal(lastTitle, expectedTitle)
		expect((await getTabState(1)).tabIconDetails).toEqual({ icon: ICON_NOT_ACTIVE, iconReason: expectedTitle })
	})

	test.each(['immediate', 'staged'])('%s access updates prompt for the latest address rather than the reconciliation snapshot', async (completion) => {
		installBrowserMock()
		const { changeSimulationMode, getSettings, updateUserAddressBookEntries, websiteSocketToString, reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate, updateWebsiteApprovalAccesses, getPendingAccessRequests, resolveInterceptorAccess } = await loadModules()
		const originalAddress = { ...firstAddress, askForAddressAccess: true }
		const selectedAddress = { ...secondAddress, askForAddressAccess: true }
		await updateUserAddressBookEntries(() => [originalAddress, selectedAddress])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: originalAddress.address })
		const snapshot = await getSettings()
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(1)
		const connections: WebsiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'example.test', approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		if (completion === 'staged') {
			const update = await reconcileWebsiteApprovalAccesses(connections, snapshot)
			await changeSimulationMode({ simulationMode: true, activeSimulationAddress: selectedAddress.address })
			await finishWebsiteAccessUpdate(ethereum, tokenPriceService, simulationServicesOwner, connections, update, true)
		} else {
			await changeSimulationMode({ simulationMode: true, activeSimulationAddress: selectedAddress.address })
			await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, simulationServicesOwner, connections, snapshot, true)
		}
		const pending = await getPendingAccessRequests()
		try {
			expect(pending.map((request) => request.requestAccessToAddress?.address)).toEqual([selectedAddress.address])
		} finally {
			for (const request of pending) {
				await resolveInterceptorAccess(ethereum, tokenPriceService, simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})

	test('rejects an invalid signing selection before changing stored settings', async () => {
		installBrowserMock()
		const { activateAddressSelection } = await loadModules()
		const before = await browser.storage.local.get()
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await assert.rejects(activateAddressSelection(simulationServicesOwner, new Map(), { type: 'addressBookEntry', entry: secondAddress }, {
			simulationMode: false, signerAddress: firstAddress.address,
		}), /Signing mode can only activate the external signer or an owned Gnosis Safe/u)
		expect(await browser.storage.local.get()).toEqual(before)
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
				await resolveInterceptorAccess(ethereum, tokenPriceService, simulationServicesOwner, connections, {
					userReply: 'noResponse', accessRequestId: request.accessRequestId,
					originalRequestAccessToAddress: selectedAddress.address, requestAccessToAddress: selectedAddress.address,
				}, noopPublishRpcConnectionStatus)
			}
		}
	})
})
