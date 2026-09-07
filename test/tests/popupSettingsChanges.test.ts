import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'
import type { RevisionedPopupSimulationRefresh } from '../../app/ts/background/popupSimulationRefresh.js'

describe('popup settings changes', () => {
	test('coalesces refreshes and waits for changes arriving during an active refresh', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefresh.js')
		const first = createDeferredValue<boolean>()
		const last = createDeferredValue<boolean>()
		const calls: RevisionedPopupSimulationRefresh[] = []
		const refresh = createPopupSimulationRefresher(async (services) => {
			calls.push(services)
			return await (calls.length === 1 ? first.promise : last.promise)
		})
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'first' }
		const result = refresh(services)
		assert.equal(refresh({ ...services, invalidateOldState: true }), result)
		await Promise.resolve()
		assert.equal(calls.length, 1)
		assert.equal(calls[0]?.invalidateOldState, true)
		assert.equal(refresh(services), result)
		const newerServices = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'second' }
		assert.equal(refresh({ ...services, invalidateOldState: true }), result)
		assert.equal(refresh({ ...newerServices, invalidateOldState: true }), result)
		let completed = false
		void result.then(() => { completed = true })
		first.resolve(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(calls.length, 2)
		assert.equal(calls[1]?.ethereum, newerServices.ethereum)
		assert.equal(calls[1]?.invalidateOldState, true)
		assert.equal(completed, false)
		last.resolve(false)
		assert.equal(await result, false)
	})

	for (const change of ['same', 'revision', 'provider', 'force'] as const) {
		test(`shares only refresh work that covers the requested revision and invalidation (${ change })`, async () => {
			installBrowserMock()
			const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefresh.js')
			const release = createDeferredValue<boolean>()
			let calls = 0
			const refresh = createPopupSimulationRefresher(async () => { calls++; return await release.promise })
			const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'one' }
			const pending = refresh(services)
			await Promise.resolve()
			const next = change === 'provider' ? { ...services, ...createEthereumWithGetBlockCounter({ count: 0 }) }
				: change === 'revision' ? { ...services, revision: 'two' }
				: change === 'force' ? { ...services, invalidateOldState: true } : services
			for (let i = 0; i < 5; i++) assert.equal(refresh(next), pending)
			release.resolve(true)
			assert.equal(await pending, true)
			assert.equal(calls, change === 'same' ? 1 : 2)
			// Completed work never suppresses a later retry or explicit refresh.
			await refresh(next)
			assert.equal(calls, change === 'same' ? 2 : 3)
		})
	}

	test('keeps the latest A request when B was queued during an active A refresh', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefresh.js')
		const release = createDeferredValue<boolean>()
		const revisions: (string | symbol)[] = []
		const refresh = createPopupSimulationRefresher(async (services) => { revisions.push(services.revision); return await release.promise })
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'A' }
		const pending = refresh(services)
		await Promise.resolve()
		refresh({ ...services, revision: 'B' })
		refresh(services)
		release.resolve(true)
		await pending
		assert.deepEqual(revisions, ['A', 'A'])
	})

	test('allows retry after a rejected refresh', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefresh.js')
		let attempts = 0
		const refresh = createPopupSimulationRefresher(async () => {
			if (++attempts === 1) throw new Error('Refresh failed')
			return true
		})
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'retry' }
		await assert.rejects(refresh(services), /Refresh failed/)
		assert.equal(await refresh(services), true)
	})

	test('coordinates settings changes across dispatchers without blocking wallet replies or reads', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { PopupSettingsChangeStatus } = await import('../../app/ts/types/interceptor-messages.js')
		const statuses = () => runtimeMessages.flatMap(message => { const parsed = PopupSettingsChangeStatus.safeParse(message); return parsed.success ? [parsed.value.data] : [] })
		const { changeSimulationMode, getSettings, saveCurrentTabId, websiteSocketToString } = await loadModules()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
		const { resolveSignerChainChange } = await import('../../app/ts/background/windows/changeChain.js')
		await changeSimulationMode({ simulationMode: false })
		await saveCurrentTabId(1)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const settings = await getSettings()
		const context = {
			...createEthereumWithGetBlockCounter({ count: 0 }), settings, websiteTabConnections: connections,
			publishRpcConnectionStatus: async () => undefined,
			simulationAbortController: new AbortController(), confirmTransactionAbortController: new AbortController(), resetSimulationState: async () => undefined,
		}
		const rpc = { ...settings.activeRpcNetwork, chainId: 2n, httpsRpc: 'https://other.example.test' }
		const pending = dispatchPopupMessage(context, { method: 'popup_changeActiveRpc', data: rpc })
		try {
			await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
			assert.equal(statuses().at(-1)?.operation, 'rpc')
			const pendingRevision = statuses().at(-1)?.revision
			await dispatchPopupMessage(context, { method: 'popup_requestSettingsChangeStatus' })
			assert.equal(statuses().at(-1)?.revision, pendingRevision)
			assert.equal(statuses().at(-1)?.operation, 'rpc')
			for (const request of [
				{ method: 'popup_changeActiveRpc', data: rpc },
				{ method: 'popup_enableSimulationMode', data: true },
				{ method: 'popup_modifyMakeMeRich', data: { address: 'CurrentAddress', add: true } },
				{ method: 'popup_changeActiveAddress', data: { simulationMode: true, activeAddress: 2n } },
			] as const) {
				const reply = await dispatchPopupMessage({ ...context }, request)
				assert.ok(reply !== undefined && 'ok' in reply && !reply.ok && reply.message.includes('Another popup'))
			}
			assert.equal((await getSettings()).simulationMode, false)
			await dispatchPopupMessage({ ...context }, { method: 'popup_requestSimulationMode' })
		} finally {
			const token = getConfirmedSignerStateToken(connections, 1)
			if (token === undefined) throw new Error('Missing signer token')
			resolveSignerChainChange(token, { method: 'popup_signerChangeChainDialog', data: [{ accept: false, chainId: 2n, error: { code: 4001, message: 'Rejected' } }] })
			await pending
		}
		assert.equal(statuses().at(-1)?.operation, undefined)
		assert.ok((statuses().at(-1)?.revision ?? 0) > (statuses()[0]?.revision ?? 0))
		const retry = await dispatchPopupMessage(context, { method: 'popup_enableSimulationMode', data: false })
		assert.deepEqual(retry, { type: 'PopupSettingsChangeReply', ok: true })
		const setStorage = browser.storage.local.set
		try {
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async () => { throw new Error('Storage unavailable') } })
			await assert.rejects(dispatchPopupMessage(context, { method: 'popup_modifyMakeMeRich', data: { address: 'CurrentAddress', add: true } }), /Storage unavailable/)
		} finally {
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: setStorage })
		}
		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_enableSimulationMode', data: false }), { type: 'PopupSettingsChangeReply', ok: true })

	})

	test('skips work when reselecting the current mode or RPC', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { changeSimulationMode, getSettings } = await loadModules()
		const { enableSimulationMode } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { changeActiveRpc } = await import('../../app/ts/background/activeSettings.js')
		await changeSimulationMode({ simulationMode: true })
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const reset = () => { throw new Error('Should not reset services') }
		const count = runtimeMessages.length
		await enableSimulationMode(ethereum, tokenPriceService, reset, new Map(), { method: 'popup_enableSimulationMode', data: true })
		await changeActiveRpc(ethereum, tokenPriceService, reset, new Map(), (await getSettings()).activeRpcNetwork, true, undefined)
		assert.equal(runtimeMessages.length, count)
	})

	for (const simulationMode of [true, false]) test(`saves active RPC metadata without resetting services in ${ simulationMode ? 'simulation' : 'signing' } mode`, async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings } = await loadModules()
		const { changeActiveRpc } = await import('../../app/ts/background/activeSettings.js')
		await changeSimulationMode({ simulationMode })
		const currentRpc = (await getSettings()).activeRpcNetwork
		if (currentRpc.httpsRpc === undefined) throw new Error('Expected a configured RPC')
		const editedRpc = { ...currentRpc, name: 'Renamed network', currencyName: 'Updated currency', currencyTicker: 'NEW', currencyLogoUri: 'updated.svg', blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: 'updated-key' }, primary: !currentRpc.primary, minimized: !currentRpc.minimized }
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const reset = () => { throw new Error('Metadata edits should not reset services') }
		assert.deepEqual(await changeActiveRpc(ethereum, tokenPriceService, reset, new Map(), editedRpc, simulationMode, undefined), { type: simulationMode ? 'completedLocally' : 'signerRequestNotNeeded' })
		assert.deepEqual((await getSettings()).activeRpcNetwork, editedRpc)
	})

	test('publishes a saved mode before slow permission work finishes', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { changeSimulationMode, changeActiveAddressAndChain, updateWebsiteAccess } = await loadModules()
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await changeSimulationMode({ simulationMode: false })
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://mode-switch-test.example' }, access: true, addressAccess: [], declarativeNetRequestBlockMode: 'block-all' }])
		const started = createDeferredValue<void>()
		const release = createDeferredValue<void>()
		Object.defineProperty(browser.declarativeNetRequest, 'getDynamicRules', { configurable: true, value: async () => {
			started.resolve(undefined)
			await release.promise
			return []
		} })
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		let completed = false
		const pending = changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, new Map(), { simulationMode: true }).then(() => { completed = true })
		try {
			await started.promise
			assert.equal(completed, false)
			assert.equal(runtimeMessages.some((message) => {
				const parsed = MessageToPopup.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_settingsUpdated' && parsed.value.data.simulationMode
			}), true)
		} finally {
			release.resolve(undefined)
			await pending
		}
	})

	test('installs the selected RPC service before publishing its settings', async () => {
		installBrowserMock()
		const { changeSimulationMode, changeActiveAddressAndChain, getSettings } = await loadModules()
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		await changeSimulationMode({ simulationMode: true })
		const rpc = { ...(await getSettings()).activeRpcNetwork, httpsRpc: 'https://replacement.example.test' }
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		let installed = false
		let announced = false
		Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: unknown) => {
			const parsed = MessageToPopup.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_settingsUpdated' && parsed.value.data.activeRpcNetwork.httpsRpc === rpc.httpsRpc) {
				assert.equal(installed, true)
				announced = true
			}
			return undefined
		} })
		await changeActiveAddressAndChain(services.ethereum, services.tokenPriceService, (entry) => {
			assert.equal(entry.httpsRpc, rpc.httpsRpc)
			installed = true
			return services
		}, new Map(), { simulationMode: true, rpcNetwork: rpc })
		assert.equal(announced, true)
	})

	test('rich changes request a visualization refresh immediately and unchanged values skip it', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { getSettings } = await loadModules()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		const context = {
			...services, settings: await getSettings(), websiteTabConnections: new Map(),
			publishRpcConnectionStatus: async () => undefined,
			simulationAbortController: new AbortController(), confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => undefined,
		}
		const refreshRequests = () => runtimeMessages.filter((message) => {
			return typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen'
		}).length
		const request = { method: 'popup_modifyMakeMeRich' as const, data: { address: 'CurrentAddress' as const, add: true } }
		const initialCount = refreshRequests()
		await dispatchPopupMessage(context, request)
		assert.ok(refreshRequests() > initialCount)
		const refreshedCount = refreshRequests()
		await dispatchPopupMessage(context, request)
		assert.equal(refreshRequests(), refreshedCount)
	})

	for (const outcome of ['accept', 'reject', 'safe'] as const) {
		test(`preserves RPC preferences until a popup wallet switch is accepted (${ outcome })`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString, updateTabState, updateUserAddressBookEntries, saveCurrentTabId } = await loadModules()
			const { popupChangeActiveRpc } = await import('../../app/ts/background/popupMessageHandlers.js')
			const { walletSwitchEthereumChainReply } = await import('../../app/ts/background/providerMessageHandlers.js')
			const { setRpcList, getRpcList } = await import('../../app/ts/background/storageVariables.js')
			const currentRpc = (await getSettings()).activeRpcNetwork
			const primaryRpc = { ...currentRpc, chainId: 2n, httpsRpc: 'https://primary.example.test', primary: true }
			const requestedRpc = { ...primaryRpc, httpsRpc: 'https://alternative.example.test', primary: false }
			const originalRpcList = [currentRpc, primaryRpc, requestedRpc]
			await setRpcList(originalRpcList)
			await changeSimulationMode({ simulationMode: false, activeSigningAddress: 1n, activeSigningSafeAddress: outcome === 'safe' ? 3n : undefined })
			await updateUserAddressBookEntries(() => [{ type: 'safe', name: 'Signing Safe', address: 3n, chainId: currentRpc.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [1n] }])
			await updateTabState(1, (previous) => ({ ...previous, signerAccounts: [1n], activeSigningAddress: 1n, signerChain: currentRpc.chainId }))
			await saveCurrentTabId(1)
			const socket = { tabId: 1, connectionName: 0n }
			const { port, messages } = createPort(1)
			const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])
			const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
			const pending = popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, connections, { method: 'popup_changeActiveRpc', data: requestedRpc }, await getSettings())
			if (outcome !== 'safe') {
				await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
				assert.deepEqual(await getRpcList(), originalRpcList)
				await walletSwitchEthereumChainReply(ethereum, tokenPriceService, resetSimulationServices, connections, port, {
					method: 'wallet_switchEthereumChain_reply',
					params: outcome === 'accept' ? [{ accept: true, chainId: '0x2', signerProviderGeneration: 1 }] : [{ accept: false, chainId: '0x2', error: { code: 4001, message: 'Rejected' }, signerProviderGeneration: 1 }],
				}, 'hasAccess', 1n)
			}
			const reply = await pending
			const activeRpc = (await getSettings()).activeRpcNetwork
			if (outcome === 'accept') {
				assert.equal(reply.ok, true)
				assert.equal(activeRpc.httpsRpc, requestedRpc.httpsRpc)
				assert.equal((await getRpcList()).find((entry) => entry.chainId === 2n && entry.primary)?.httpsRpc, requestedRpc.httpsRpc)
			} else {
				assert.equal(reply.ok, false)
				assert.equal(activeRpc.httpsRpc, currentRpc.httpsRpc)
				assert.deepEqual(await getRpcList(), originalRpcList)
				if (outcome === 'safe') {
					assert.equal(messages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
					assert.ok(!reply.ok && reply.message.includes('Safe'))
				}
			}
		})
	}

	for (const outcome of ['timeout', 'reply', 'failure'] as const) {
		test(`wallet deadline releases a silent request but does not expire a received reply (${ outcome })`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString } = await loadModules()
			const { requestSignerChainChange, resolveSignerChainChange, markSignerChainReplyReceived } = await import('../../app/ts/background/windows/changeChain.js')
			const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
			await changeSimulationMode({ simulationMode: false })
			const socket = { tabId: 1, connectionName: 0n }
			const { port, messages } = createPort(1)
			const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])
			const rpc = { ...(await getSettings()).activeRpcNetwork, chainId: 2n, httpsRpc: 'https://timeout.example.test' }
			const services = createEthereumWithGetBlockCounter({ count: 0 })
			const request = (timeoutMs: number) => requestSignerChainChange(services.ethereum, services.tokenPriceService, services.resetSimulationServices, connections, rpc, 1, timeoutMs)
			const pending = request(30)
			await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
			const token = getConfirmedSignerStateToken(connections, 1)
			if (token === undefined) throw new Error('Missing signer token')
			const reply = { method: 'popup_signerChangeChainDialog', data: [{ accept: false, chainId: 2n, error: { code: 4001, message: 'Rejected' } }] } as const
			if (outcome === 'failure') {
				const { walletSwitchEthereumChainReply } = await import('../../app/ts/background/providerMessageHandlers.js')
				const originalSet = browser.storage.local.set
				try {
					Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async () => { throw new Error('Storage write failed') } })
					await assert.rejects(walletSwitchEthereumChainReply(services.ethereum, services.tokenPriceService, services.resetSimulationServices, connections, port, {
						method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: '0x2', signerProviderGeneration: token.signerProviderGeneration }],
						interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
					}, 'hasAccess', undefined), /Storage write failed/)
				} finally { Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet }) }
				assert.match((await pending).error?.message ?? '', /updating the selected network failed/)
			} else if (outcome === 'reply') {
				// Delivery has begun, but applying the accepted wallet state can involve slower RPC work.
				await new Promise(resolve => setTimeout(resolve, 0))
				markSignerChainReplyReceived(token, 2n)
				await new Promise(resolve => setTimeout(resolve, 60))
				resolveSignerChainChange(token, reply)
				assert.equal((await pending).error?.code, 4001)
			} else {
				assert.match((await pending).error?.message ?? '', /did not answer/)
				assert.match((await request(30)).error?.message ?? '', /previous network request/)
				assert.equal(messages.filter(message => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
				const { walletSwitchEthereumChainReply } = await import('../../app/ts/background/providerMessageHandlers.js')
				const beforeLateReply = await getSettings()
				await walletSwitchEthereumChainReply(services.ethereum, services.tokenPriceService, services.resetSimulationServices, connections, port, {
					method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: '0x2', signerProviderGeneration: token.signerProviderGeneration }],
					interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
				}, 'hasAccess', undefined)
				assert.deepEqual((await getSettings()).activeRpcNetwork, beforeLateReply.activeRpcNetwork)
				const retry = request(1000)
				await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 2)
				resolveSignerChainChange(token, reply)
				assert.equal((await retry).error?.code, 4001)
				await request(30)
				const tab = connections.get(1)
				if (tab === undefined) throw new Error('Missing tab')
				tab.signerStateOwner.providerGeneration++
				let newRequestCompleted = false
				const newRequest = request(1000).then(result => { newRequestCompleted = true; return result })
				await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 4)
				await walletSwitchEthereumChainReply(services.ethereum, services.tokenPriceService, services.resetSimulationServices, connections, port, {
					method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: '0x2', signerProviderGeneration: token.signerProviderGeneration }],
					interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
				}, 'hasAccess', undefined)
				assert.equal(newRequestCompleted, false)
				const newToken = getConfirmedSignerStateToken(connections, 1)
				if (newToken === undefined) throw new Error('Missing reconnected signer')
				resolveSignerChainChange(newToken, reply)
				assert.equal((await newRequest).error?.code, 4001)
			}
		})
	}

	for (const accept of [true, false]) {
		test(`waits for the matching wallet network ${ accept ? 'acceptance' : 'rejection' }`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString } = await loadModules()
			const { requestSignerChainChange, resolveSignerChainChange } = await import('../../app/ts/background/windows/changeChain.js')
			await changeSimulationMode({ simulationMode: false })
			const socket = { tabId: 1, connectionName: 0n }
			const ownership = confirmedSignerOwnership(socket)
			const { port, messages } = createPort(socket.tabId)
			const connections = new Map([[1, { ...ownership, connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])
			const rpc = { ...(await getSettings()).activeRpcNetwork, chainId: 2n, httpsRpc: 'https://rpc.example.test' }
			const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
			let completed = false
			const pending = requestSignerChainChange(ethereum, tokenPriceService, resetSimulationServices, connections, rpc, 1).then((result) => { completed = true; return result })
			await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
			assert.equal(completed, false)
			const concurrent = await requestSignerChainChange(ethereum, tokenPriceService, resetSimulationServices, connections, rpc, 1)
			assert.equal(concurrent.error?.code, -32002)
			const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
			const token = getConfirmedSignerStateToken(connections, 1)
			if (token === undefined) throw new Error('Expected signer owner')
			resolveSignerChainChange(token, {
				method: 'popup_signerChangeChainDialog',
				data: accept ? [{ accept: true, chainId: rpc.chainId }] : [{ accept: false, chainId: rpc.chainId, error: { code: 4001, message: 'User rejected network change' } }],
			})
			const result = await pending
			if (accept) assert.equal(result.result, null)
			else assert.equal(result.error?.message, 'User rejected network change')
		})
	}
})
