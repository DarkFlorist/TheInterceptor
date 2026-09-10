import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getWalletSwitchRequestId, confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'
import type { RevisionedPopupSimulationRefresh } from '../../app/ts/background/popupSimulationRefreshQueue.js'

describe('popup settings changes', () => {
	for (const firstSucceeded of [true, false]) test(`keeps overlapping refresh outcomes independent (first=${ firstSucceeded })`, async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const first = createDeferredValue<boolean>()
		const last = createDeferredValue<boolean>()
		const started = createDeferredValue<void>()
		const refresh = createPopupSimulationRefresher(async services => {
			if (services.revision === 'first') { started.resolve(undefined); return await first.promise }
			return await last.promise
		})
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'first' }
		const result = refresh(services)
		await started.promise
		assert.equal(refresh(services), result)
		const next = refresh({ ...services, revision: 'second' })
		assert.notEqual(next, result)
		first.resolve(firstSucceeded)
		assert.deepEqual(await result, { status: 'observed', available: firstSucceeded })
		last.resolve(!firstSucceeded)
		assert.deepEqual(await next, { status: 'observed', available: !firstSucceeded })
	})

	for (const change of ['same', 'revision', 'provider', 'force'] as const) {
		test(`shares only refresh work that covers the requested revision and invalidation (${ change })`, async () => {
			installBrowserMock()
			const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
			const release = createDeferredValue<boolean>()
			const started = createDeferredValue<void>()
			let calls = 0
			const refresh = createPopupSimulationRefresher(async () => { calls++; started.resolve(undefined); return await release.promise })
			const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'one' }
			const pending = refresh(services)
			await started.promise
			const next = change === 'provider' ? { ...services, ...createEthereumWithGetBlockCounter({ count: 0 }) }
				: change === 'revision' ? { ...services, revision: 'two' }
				: change === 'force' ? { ...services, invalidateOldState: true } : services
			const nextResult = refresh(next)
			assert.equal(nextResult === pending, change === 'same')
			for (let i = 0; i < 5; i++) assert.equal(refresh(next), nextResult)
			release.resolve(true)
			assert.deepEqual(await pending, { status: 'observed', available: true })
			assert.deepEqual(await nextResult, { status: 'observed', available: true })
			assert.equal(calls, change === 'same' ? 1 : 2)
			await refresh(next)
			assert.equal(calls, change === 'same' ? 2 : 3)
		})
	}

	test('supersedes queued B with the latest A and carries forward invalidation', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const release = createDeferredValue<boolean>()
		const started = createDeferredValue<void>()
		const calls: RevisionedPopupSimulationRefresh[] = []
		const refresh = createPopupSimulationRefresher(async services => { calls.push(services); started.resolve(undefined); return await release.promise })
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'A' }
		const first = refresh(services)
		await started.promise
		const skipped = refresh({ ...services, revision: 'B', invalidateOldState: true })
		const last = refresh(services)
		assert.notEqual(first, last)
		assert.deepEqual(await skipped, { status: 'superseded' })
		release.resolve(true)
		assert.deepEqual(await first, { status: 'observed', available: true })
		assert.deepEqual(await last, { status: 'observed', available: true })
		assert.deepEqual(calls.map(call => call.revision), ['A', 'A'])
		assert.equal(calls[1]?.invalidateOldState, true)
	})

	test('merges invalidation for equivalent work before it starts', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const refresh = createPopupSimulationRefresher(async services => services.invalidateOldState === true)
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'A' }
		const result = refresh(services)
		assert.equal(refresh({ ...services, invalidateOldState: true }), result)
		assert.deepEqual(await result, { status: 'observed', available: true })
	})

	test('rejects only the failed entry and continues queued work and retries', async () => {
		installBrowserMock()
		const { createPopupSimulationRefresher } = await import('../../app/ts/background/popupSimulationRefreshQueue.js')
		const release = createDeferredValue<void>()
		const started = createDeferredValue<void>()
		let attempts = 0
		const refresh = createPopupSimulationRefresher(async () => {
			if (++attempts === 1) { started.resolve(undefined); await release.promise; throw new Error('Refresh failed') }
			return true
		})
		const services = { ...createEthereumWithGetBlockCounter({ count: 0 }), revision: 'first' }
		const failed = assert.rejects(refresh(services), /Refresh failed/)
		await started.promise
		const queued = refresh({ ...services, revision: 'second' })
		release.resolve(undefined)
		await failed
		assert.deepEqual(await queued, { status: 'observed', available: true })
		assert.deepEqual(await refresh(services), { status: 'observed', available: true })
	})

	test('coordinates settings changes across dispatchers without blocking wallet replies or reads', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { PopupSettingsChangeStatus } = await import('../../app/ts/types/interceptor-messages.js')
		const statuses = () => runtimeMessages.flatMap(message => { const parsed = PopupSettingsChangeStatus.safeParse(message); return parsed.success ? [parsed.value.data] : [] })
		const { changeSimulationMode, getSettings, saveCurrentTabId, websiteSocketToString } = await loadModules()
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
		const { applyWalletSwitchReply } = await import('../../app/ts/background/walletSwitch.js')
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
			await applyWalletSwitchReply(connections, port, { accept: false, chainId: 2n, walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: token.signerProviderGeneration, error: { code: 4001, message: 'Rejected' } }, async () => undefined)
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
		const { changeActiveRpc } = await import('../../app/ts/background/walletSwitch.js')
		await changeSimulationMode({ simulationMode: true })
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const reset = createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => { throw new Error('Should not reset services') })
		const count = runtimeMessages.length
		await enableSimulationMode(reset, new Map(), { method: 'popup_enableSimulationMode', data: true })
		await changeActiveRpc(reset, new Map(), (await getSettings()).activeRpcNetwork, { source: 'dapp', simulationMode: true, signerTabId: undefined })
		assert.equal(runtimeMessages.length, count)
	})

	for (const simulationMode of [true, false]) test(`saves active RPC metadata without resetting services in ${ simulationMode ? 'simulation' : 'signing' } mode`, async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings, saveCurrentTabId, websiteSocketToString } = await loadModules()
		const { changeActiveRpc } = await import('../../app/ts/background/walletSwitch.js')
		const { popupChangeActiveRpc } = await import('../../app/ts/background/popupMessageHandlers.js')
		await saveCurrentTabId(1)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		await changeSimulationMode({ simulationMode })
		const currentRpc = (await getSettings()).activeRpcNetwork
		if (currentRpc.httpsRpc === undefined) throw new Error('Expected a configured RPC')
		const editedRpc = { ...currentRpc, name: 'Renamed network', currencyName: 'Updated currency', currencyTicker: 'NEW', currencyLogoUri: 'updated.svg', blockExplorer: { apiUrl: 'https://explorer.example/api', apiKey: 'updated-key' }, primary: !currentRpc.primary, minimized: !currentRpc.minimized }
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const reset = createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => { throw new Error('Metadata edits should not reset services') })
		assert.deepEqual(await changeActiveRpc(reset, connections, editedRpc, { source: 'dapp', simulationMode: simulationMode, signerTabId: 1 }), { result: null })
		assert.deepEqual((await getSettings()).activeRpcNetwork, editedRpc)
		const popupEdit = { ...editedRpc, name: 'Renamed through popup' }
		assert.deepEqual(await popupChangeActiveRpc(reset, connections, { method: 'popup_changeActiveRpc', data: popupEdit }), { type: 'PopupSettingsChangeReply', ok: true })
		assert.deepEqual((await getSettings()).activeRpcNetwork, popupEdit)
		assert.equal(messages.some(message => message.method === 'request_signer_to_wallet_switchEthereumChain'), false, 'Metadata edits must not ask a connected wallet to switch chains')
	})

	for (const simulationMode of [true, false]) for (const reselect of [true, false]) test(`local RPC selection persists the chain preference (simulation=${ simulationMode }, reselect=${ reselect })`, async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings } = await loadModules()
		const { changeActiveRpc } = await import('../../app/ts/background/walletSwitch.js')
		const { setRpcList, getPrimaryRpcForChain } = await import('../../app/ts/background/storageVariables.js')
		const current = (await getSettings()).activeRpcNetwork
		if (current.httpsRpc === undefined) throw new Error('Expected a configured RPC')
		const selected = { ...current, httpsRpc: 'https://selected.example', primary: false }
		await setRpcList([{ ...current, primary: true }, selected])
		await changeSimulationMode({ simulationMode, rpcNetwork: reselect ? selected : current })
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		await changeActiveRpc(services.simulationServicesOwner, new Map(), selected, { source: 'dapp', simulationMode: simulationMode, signerTabId: undefined })
		assert.equal((await getPrimaryRpcForChain(selected.chainId))?.httpsRpc, selected.httpsRpc)
		assert.equal((await getSettings()).activeRpcNetwork.httpsRpc, selected.httpsRpc)
	})

	test('activation installs services once without exposing a potentially superseded snapshot', async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings } = await loadModules()
		const { activateAddressSelection } = await import('../../app/ts/background/activeSettings.js')
		await changeSimulationMode({ simulationMode: true })
		const currentRpc = (await getSettings()).activeRpcNetwork
		if (currentRpc.httpsRpc === undefined) throw new Error('Expected a configured RPC')
		const nextRpc = { ...currentRpc, httpsRpc: 'https://replacement.example' }
		const original = createEthereumWithGetBlockCounter({ count: 0 })
		const installed = createEthereumWithGetBlockCounter({ count: 0 })
		let resets = 0
		const reset = createTestSimulationServicesOwner(original, (rpc: typeof nextRpc) => {
			assert.deepEqual(rpc, nextRpc)
			resets += 1
			return installed
		})
		const options = { simulationMode: true, signerAddress: undefined, rpcNetwork: nextRpc }
		const active = await activateAddressSelection(reset, new Map(), undefined, options)
		assert.equal(active, undefined)
		const unchanged = await activateAddressSelection(reset, new Map(), undefined, options)
		assert.equal(unchanged, undefined)
		assert.equal(resets, 1)
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		let completed = false
		const pending = changeActiveAddressAndChain(simulationServicesOwner, new Map(), { simulationMode: true }).then(() => { completed = true })
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
		await changeActiveAddressAndChain(createTestSimulationServicesOwner({ ethereum: services.ethereum, tokenPriceService: services.tokenPriceService }, (entry) => {
			assert.equal(entry.httpsRpc, rpc.httpsRpc)
			installed = true
			return services
		}), new Map(), { simulationMode: true, rpcNetwork: rpc })
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

	for (const outcome of ['accept', 'reject', 'safe', 'metadata after chain event', 'unavailable simulation'] as const) {
		test(`preserves RPC preferences until a popup wallet switch is accepted (${ outcome })`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString, updateTabState, updateUserAddressBookEntries, saveCurrentTabId } = await loadModules()
			const { popupChangeActiveRpc } = await import('../../app/ts/background/popupMessageHandlers.js')
			const { walletSwitchEthereumChainReply, signerChainChanged } = await import('../../app/ts/background/providerMessageHandlers.js')
			const { setRpcList, getRpcList, getPrimaryRpcForChain } = await import('../../app/ts/background/storageVariables.js')
			const currentRpc = (await getSettings()).activeRpcNetwork
			const primaryRpc = { ...currentRpc, chainId: 2n, httpsRpc: 'https://primary.example.test', primary: true }
			const requestedRpc = { ...primaryRpc, name: 'Requested network', httpsRpc: outcome === 'metadata after chain event' ? primaryRpc.httpsRpc : 'https://alternative.example.test', primary: false }
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
			const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
			let simulationReads = 0
			if (outcome === 'unavailable simulation') Object.defineProperty(ethereum, 'getCachedBlock', { value: () => {
				simulationReads += 1
				throw new Error('Simulation RPC is unavailable')
			} })
			const pending = popupChangeActiveRpc(simulationServicesOwner, connections, { method: 'popup_changeActiveRpc', data: requestedRpc })
			if (outcome !== 'safe') {
				await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
				assert.deepEqual(await getRpcList(), originalRpcList)
				if (outcome === 'metadata after chain event') {
					await signerChainChanged(ethereum, tokenPriceService, simulationServicesOwner, connections, port, { method: 'signer_chainChanged', params: ['0x2', 1] }, 'hasAccess', 1n)
					assert.deepEqual((await getSettings()).activeRpcNetwork, primaryRpc)
				}
				await walletSwitchEthereumChainReply(ethereum, tokenPriceService, simulationServicesOwner, connections, port, {
					method: 'wallet_switchEthereumChain_reply',
					params: outcome !== 'reject' ? [{ accept: true, chainId: '0x2', walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: 1 }] : [{ accept: false, chainId: '0x2', walletSwitchRequestId: getWalletSwitchRequestId(messages), error: { code: 4001, message: 'Rejected' }, signerProviderGeneration: 1 }],
				}, 'hasAccess', 1n)
			}
			const reply = await pending
			const activeRpc = (await getSettings()).activeRpcNetwork
			if (outcome !== 'reject' && outcome !== 'safe') {
				assert.equal(simulationReads, 0, 'External-wallet signing must not read simulation state before acknowledging the switch')
				assert.equal(reply.ok, true)
				assert.deepEqual(activeRpc, requestedRpc)
				assert.equal((await getRpcList()).find((entry) => entry.name === requestedRpc.name)?.primary, true)
				assert.equal((await getRpcList()).find((entry) => entry.chainId === 2n && entry.primary)?.httpsRpc, requestedRpc.httpsRpc)
				assert.equal((await getRpcList()).filter((entry) => entry.chainId === 2n && entry.primary).length, 1)
				assert.deepEqual(await getPrimaryRpcForChain(2n), { ...requestedRpc, primary: true })
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

	for (const crossChain of [true, false]) test(`dapp RPC changes preserve the selected Safe chain (crossChain=${ crossChain })`, async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings, websiteSocketToString, updateTabState, updateUserAddressBookEntries } = await loadModules()
		const { changeActiveRpc, isSignerChainChangePending } = await import('../../app/ts/background/walletSwitch.js')
		const { setRpcList, getRpcList } = await import('../../app/ts/background/storageVariables.js')
		const currentRpc = (await getSettings()).activeRpcNetwork
		const requestedRpc = { ...currentRpc, chainId: crossChain ? 2n : currentRpc.chainId, name: 'Alternative RPC', httpsRpc: 'https://alternative.example.test', primary: false }
		const rpcList = [currentRpc, requestedRpc]
		await setRpcList(rpcList)
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: 1n, activeSigningSafeAddress: 3n })
		await updateUserAddressBookEntries(() => [{ type: 'safe', name: 'Signing Safe', address: 3n, chainId: currentRpc.chainId, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [1n] }])
		await updateTabState(1, previous => ({ ...previous, signerAccounts: [1n], activeSigningAddress: 1n, signerChain: currentRpc.chainId }))
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const reply = await changeActiveRpc(simulationServicesOwner, connections, requestedRpc, { source: 'dapp', signerTabId: 1, simulationMode: false }, 10)
		const settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, 3n)
		assert.equal(messages.some(message => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
		assert.equal(isSignerChainChangePending(), false)
		if (crossChain) {
			assert.equal(reply.error?.code, 4001)
			assert.match(reply.error?.message ?? '', /Safe.*current network/u)
			assert.deepEqual(settings.activeRpcNetwork, currentRpc)
			assert.deepEqual(await getRpcList(), rpcList)
		} else {
			assert.deepEqual(reply, { result: null })
			assert.deepEqual(settings.activeRpcNetwork, requestedRpc)
			assert.equal((await getRpcList()).find(rpc => rpc.name === requestedRpc.name)?.primary, true)
		}
	})

	for (const matchesDispatchedToken of [true, false]) test(`early reply deadline ownership matches the dispatched signer token (${ matchesDispatchedToken })`, async () => {
		installBrowserMock()
		const { changeSimulationMode, getSettings, websiteSocketToString } = await loadModules()
		const { changeActiveRpc, applyWalletSwitchReply } = await import('../../app/ts/background/walletSwitch.js')
		await changeSimulationMode({ simulationMode: false })
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const ownership = confirmedSignerOwnership(socket)
		const connections = new Map([[1, { ...ownership, connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const rpc = { ...(await getSettings()).activeRpcNetwork, chainId: 2n, httpsRpc: 'https://early-reply.example.test' }
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		let delivery: Promise<void> | undefined
		const originalPost = port.postMessage
		port.postMessage = message => {
			originalPost(message)
			if (message.method !== 'request_signer_to_wallet_switchEthereumChain') return
			// Exercise receipt before the send path returns its captured token, independently of replacement notifications.
			if (!matchesDispatchedToken) ownership.signerStateOwner.generation += 1
			delivery = applyWalletSwitchReply(connections, port, {
				accept: false, chainId: rpc.chainId, walletSwitchRequestId: getWalletSwitchRequestId(messages),
				signerProviderGeneration: ownership.signerStateOwner.providerGeneration,
				error: { code: 4001, message: 'Rejected early' },
			}, async () => { throw new Error('A rejected reply must not apply a chain') })
		}
		const originalSend = browser.runtime.sendMessage
		try {
			Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: unknown) => {
				await delivery
				return await originalSend(message)
			} })
			const result = await changeActiveRpc(services.simulationServicesOwner, connections, rpc, { source: 'dapp', simulationMode: false, signerTabId: 1 }, 20)
			assert.match(result.error?.message ?? '', matchesDispatchedToken ? /Rejected early/ : /did not answer/)
		} finally { Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: originalSend }) }
	})

	for (const outcome of ['timeout', 'reply', 'failure'] as const) {
		test(`wallet deadline releases a silent request but does not expire a received reply (${ outcome })`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString } = await loadModules()
			const { changeActiveRpc, applyWalletSwitchReply } = await import('../../app/ts/background/walletSwitch.js')
			const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
			await changeSimulationMode({ simulationMode: false })
			const socket = { tabId: 1, connectionName: 0n }
			const { port, messages } = createPort(1)
			const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])
			const rpc = { ...(await getSettings()).activeRpcNetwork, chainId: 2n, httpsRpc: 'https://timeout.example.test' }
			const services = createEthereumWithGetBlockCounter({ count: 0 })
			const request = (timeoutMs: number) => changeActiveRpc(services.simulationServicesOwner, connections, rpc, { source: 'dapp', simulationMode: false, signerTabId: 1 }, timeoutMs)
			const token = getConfirmedSignerStateToken(connections, 1)
			if (token === undefined) throw new Error('Missing signer token')
			const application = createDeferredValue<void>()
			let delivery: Promise<void> | undefined
			if (outcome === 'reply') {
				const postMessage = port.postMessage
				port.postMessage = message => {
					postMessage(message)
					// Simulate delivery before changeActiveRpc has returned its signer token.
					if (message.method === 'request_signer_to_wallet_switchEthereumChain') delivery = applyWalletSwitchReply(connections, port, { accept: true, chainId: 2n, walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: token.signerProviderGeneration }, async () => { await application.promise; await changeSimulationMode({ simulationMode: false, rpcNetwork: rpc }) })
				}
			}
			const pending = request(30)
			await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
			if (outcome === 'failure') {
				const { walletSwitchEthereumChainReply } = await import('../../app/ts/background/providerMessageHandlers.js')
				const originalSet = browser.storage.local.set
				try {
					Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async () => { throw new Error('Storage write failed') } })
					await assert.rejects(walletSwitchEthereumChainReply(services.ethereum, services.tokenPriceService, services.simulationServicesOwner, connections, port, {
						method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: '0x2', walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: token.signerProviderGeneration }],
						interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
					}, 'hasAccess', undefined), /Storage write failed/)
				} finally { Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet }) }
				assert.match((await pending).error?.message ?? '', /updating the selected network failed/)
			} else if (outcome === 'reply') {
				// Delivery has begun, but applying the accepted wallet state can involve slower RPC work.
				await new Promise(resolve => setTimeout(resolve, 60))
				application.resolve(undefined)
				await delivery
				assert.equal((await pending).error, undefined)
				assert.strictEqual((await pending).result, null)
			} else {
				assert.match((await pending).error?.message ?? '', /did not answer/)
				const expiredId = getWalletSwitchRequestId(messages)
				const { walletSwitchEthereumChainReply } = await import('../../app/ts/background/providerMessageHandlers.js')
				const { setChainChangeConfirmationPromise, resolveChainChange } = await loadModules()
				const dappRpc = { ...rpc, httpsRpc: 'https://dapp-switch.example.test' }
				const uniqueRequestIdentifier = { requestId: 55, requestSocket: socket }
				await setChainChangeConfirmationPromise({
					website: { websiteOrigin: 'https://example.test' }, popupOrTabId: { type: 'popup', id: 10 }, simulationMode: false, rpcNetwork: dappRpc,
					request: { method: 'wallet_switchEthereumChain', params: [{ chainId: 2n }], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier },
				})
				let completed = false
				const dappSwitch = resolveChainChange(services.ethereum, services.tokenPriceService, services.simulationServicesOwner, connections, {
					method: 'popup_changeChainDialog', data: { rpcNetwork: dappRpc, uniqueRequestIdentifier, accept: true },
				}).then(() => { completed = true })
				await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 2)
				const dappId = getWalletSwitchRequestId(messages)
				assert.notEqual(dappId, expiredId)
				const deliver = (walletSwitchRequestId: string) => walletSwitchEthereumChainReply(services.ethereum, services.tokenPriceService, services.simulationServicesOwner, connections, port, {
					method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: '0x2', walletSwitchRequestId, signerProviderGeneration: token.signerProviderGeneration }],
					interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
				}, 'hasAccess', undefined)
				const beforeLateReply = (await getSettings()).activeRpcNetwork
				await deliver(expiredId)
				assert.equal(completed, false)
				assert.deepEqual((await getSettings()).activeRpcNetwork, beforeLateReply)
				await deliver(dappId)
				await dappSwitch
				assert.equal((await getSettings()).activeRpcNetwork.httpsRpc, dappRpc.httpsRpc)
				assert.equal(messages.find(message => message.method === 'wallet_switchEthereumChain' && message.requestId === 55)?.result, null)
				await deliver(expiredId)
				assert.equal((await getSettings()).activeRpcNetwork.httpsRpc, dappRpc.httpsRpc)
			}
		})
	}

	for (const outcome of ['acceptance', 'rejection', 'endpoint mismatch'] as const) {
		const accept = outcome !== 'rejection'
		test(`waits for the matching wallet network ${ outcome }`, async () => {
			installBrowserMock()
			const { changeSimulationMode, getSettings, websiteSocketToString } = await loadModules()
			const { changeActiveRpc, applyWalletSwitchReply } = await import('../../app/ts/background/walletSwitch.js')
			await changeSimulationMode({ simulationMode: false })
			const socket = { tabId: 1, connectionName: 0n }
			const ownership = confirmedSignerOwnership(socket)
			const { port, messages } = createPort(socket.tabId)
			const connections = new Map([[1, { ...ownership, connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])
			const rpc = { ...(await getSettings()).activeRpcNetwork, chainId: 2n, httpsRpc: 'https://rpc.example.test' }
			const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
			let completed = false
			const pending = changeActiveRpc(simulationServicesOwner, connections, rpc, { source: 'dapp', simulationMode: false, signerTabId: 1 }).then((result) => { completed = true; return result })
			await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
			assert.equal(completed, false)
			const concurrent = await changeActiveRpc(simulationServicesOwner, connections, rpc, { source: 'dapp', simulationMode: false, signerTabId: 1 })
			assert.equal(concurrent.error?.code, -32002)
			const { getConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
			const token = getConfirmedSignerStateToken(connections, 1)
			if (token === undefined) throw new Error('Expected signer owner')
			const replyBase = { chainId: rpc.chainId, walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: token.signerProviderGeneration }
			await applyWalletSwitchReply(connections, port, accept ? { ...replyBase, accept: true } : { ...replyBase, accept: false, error: { code: 4001, message: 'User rejected network change' } }, async () => { if (outcome === 'acceptance') await changeSimulationMode({ simulationMode: false, rpcNetwork: rpc }) })
			const result = await pending
			if (outcome === 'acceptance') {
				assert.equal(result.error, undefined)
				assert.strictEqual(result.result, null)
			} else if (outcome === 'endpoint mismatch') {
				assert.match(result.error?.message ?? '', /could not activate the requested network/)
				assert.notEqual((await getSettings()).activeRpcNetwork.httpsRpc, rpc.httpsRpc)
			} else assert.equal(result.error?.message, 'User rejected network change')
		})
	}
})
