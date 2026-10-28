import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const isVisualizerOpenRequest = (message: unknown) => hasMessageMethod(message, 'popup_isSimulationVisualizerOpen')

// Answers the popup's "is the simulation visualizer open" question with "no", like a background with no visualizer window.
const replyVisualizerClosed = (message: unknown) => isVisualizerOpenRequest(message) ? { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: false } } : undefined

describe('background active address switching', () => {
	test('confirms a persisted popup address before slow permission work completes', async () => {
		const browserMock = installBrowserMock()
		const { runtimeMessages } = browserMock
		const { changeActiveAddress, changeSimulationMode, getSettings, updateUserAddressBookEntries, updateWebsiteAccess } = await loadModules()
		const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
		const previousAddress = 1n
		const nextAddress = 2n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousAddress })
		await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Next wallet', address: nextAddress, entrySource: 'User', useAsActiveAddress: true }])
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://address-switch-test.example', icon: undefined, title: undefined }, access: true, addressAccess: [], declarativeNetRequestBlockMode: 'block-all' }])
		const permissionWorkStarted = Promise.withResolvers<void>()
		const releasePermissionWork = Promise.withResolvers<void>()
		browserMock.browser.declarativeNetRequest.getDynamicRules = async () => {
			permissionWorkStarted.resolve()
			await releasePermissionWork.promise
			return []
		}
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		let completed = false
		const change = changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: nextAddress, simulationMode: true },
		}).then((reply) => { completed = true; return reply })
		try {
			await permissionWorkStarted.promise
			assert.equal(completed, false)
			assert.equal((await getSettings()).activeSimulationAddress, nextAddress)
			const committed = runtimeMessages.map((message) => MessageToPopup.safeParse(message)).find((parsed) => parsed.success && parsed.value.method === 'popup_settingsUpdated')
			assert.ok(committed?.success && committed.value.method === 'popup_settingsUpdated')
			if (committed?.success && committed.value.method === 'popup_settingsUpdated') {
				assert.equal(committed.value.data.activeSimulationAddress, nextAddress)
			}
		} finally {
			releasePermissionWork.resolve()
			await change
		}
		assert.equal((await change).ok, true)
		const settingsBroadcasts = runtimeMessages.map(message => MessageToPopup.safeParse(message)).filter(parsed => parsed.success && parsed.value.method === 'popup_settingsUpdated')
		assert.equal(settingsBroadcasts.length, 1, 'One authoritative settings broadcast must cover the entire transition')
	})

	test('refreshes the cached signing visualization when selecting another Safe on the same chain', async () => {
		const { runtimeMessages } = installBrowserMock({ handlers: { runtimeMessage: replyVisualizerClosed } })
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings } = await loadModules()
		const firstSafe = 0x1010101010101010101010101010101010101010n
		const secondSafe = 0x2020202020202020202020202020202020202020n
		await changeSimulationMode({ simulationMode: false, activeSigningSafeAddress: firstSafe })
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, new Map(), {
			simulationMode: false,
			activeAddress: secondSafe,
			signingAddressSelection: 'safe',
			promptForAccessesIfNeeded: false,
		})

		assert.equal((await getSettings()).activeSigningSafeAddress, secondSafe)
		assert.equal(runtimeMessages.some(isVisualizerOpenRequest), true)
	})

	test('refreshes the cached signing visualization when the active Safe context changes chain', async () => {
		const { runtimeMessages } = installBrowserMock({ handlers: { runtimeMessage: replyVisualizerClosed } })
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings } = await loadModules()
		const safeAddress = 0x3030303030303030303030303030303030303030n
		await changeSimulationMode({ simulationMode: false, activeSigningSafeAddress: safeAddress })
		const previousNetwork = (await getSettings()).activeRpcNetwork
		const nextNetwork = {
			...previousNetwork,
			name: 'Other chain',
			chainId: previousNetwork.chainId + 1n,
			httpsRpc: 'https://other-chain.example',
			primary: false,
		}
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, new Map(), {
			simulationMode: false,
			rpcNetwork: nextNetwork,
			promptForAccessesIfNeeded: false,
		})

		assert.equal((await getSettings()).activeSigningSafeAddress, safeAddress)
		assert.equal(runtimeMessages.some(isVisualizerOpenRequest), true)
	})

	test('rejects arbitrary EOAs and unverified or unowned Safes selected through popup signing-mode bypasses', async () => {
		const { readStoredValue } = installBrowserMock()
		const {
			changeActiveAddress,
			changeSimulationMode,
			getSettings,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const signerAddress = 0x1111111111111111111111111111111111111111n
		const arbitraryEoa = 0x2222222222222222222222222222222222222222n
		const unownedSafe = 0x3333333333333333333333333333333333333333n
		const unverifiedSafe = 0x4444444444444444444444444444444444444444n
		const tabId = 199
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: signerAddress })
		await setUseSignersAddressAsActiveAddress(true, signerAddress)
		await updateUserAddressBookEntries(() => [
			{
				type: 'contact',
				name: 'Arbitrary EOA',
				address: arbitraryEoa,
				entrySource: 'User',
				useAsActiveAddress: true,
				askForAddressAccess: true,
			},
			{
				type: 'safe',
				name: 'Unowned Safe',
				address: unownedSafe,
				chainId: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
				safeSignerAddresses: [arbitraryEoa],
			},
			{
				type: 'safe',
				name: 'Unverified Safe',
				address: unverifiedSafe,
				chainId: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
			},
		])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [signerAddress], activeSigningAddress: signerAddress }))
		await saveCurrentTabId(tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: arbitraryEoa, simulationMode: false },
		})
		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: unownedSafe, simulationMode: false },
		})
		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: unverifiedSafe, simulationMode: false },
		})

		const settings = await getSettings()
		assert.equal(readStoredValue('activeSigningAddress'), signerAddress)
		assert.equal(settings.useSignersAddressAsActiveAddress, true)
	})

	test('rejects a wrong-chain Safe selected through a simulation-mode popup bypass', async () => {
		installBrowserMock()
		const {
			changeActiveAddress,
			changeSimulationMode,
			getSettings,
			updateUserAddressBookEntries,
		} = await loadModules()
		const originalAddress = 0x3131313131313131313131313131313131313131n
		const wrongChainSafe = 0x4141414141414141414141414141414141414141n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: originalAddress })
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Wrong-chain Safe',
			address: wrongChainSafe,
			chainId: 10n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [],
		}])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		assert.deepEqual(
			await changeActiveAddress(simulationServicesOwner, new Map(), {
				method: 'popup_changeActiveAddress',
				data: { activeAddress: wrongChainSafe, simulationMode: true },
			}),
			{
				type: 'ChangeActiveAddressReply',
				ok: false,
				message: 'The selected Gnosis Safe is configured for another chain.',
			},
		)
		assert.equal((await getSettings()).activeSimulationAddress, originalAddress)
	})

	test('does not classify a signer EOA as a Safe from another chain', async () => {
		const { readStoredValue } = installBrowserMock()
		const {
			changeActiveAddressAndChain,
			activateAddressSelection,
			changeSimulationMode,
			getSettings,
			updateUserAddressBookEntries,
		} = await loadModules()
		const signerAddress = 0x4141414141414141414141414141414141414141n
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: undefined, activeSigningSafeAddress: undefined })
		const activeChainId = (await getSettings()).activeRpcNetwork.chainId
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Other-chain Safe with signer address',
			address: signerAddress,
			chainId: activeChainId + 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [],
		}])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, new Map(), {
			simulationMode: false,
			activeAddress: signerAddress,
			signingAddressSelection: 'signer',
			promptForAccessesIfNeeded: false,
		})

		const settings = await getSettings()
		assert.equal(readStoredValue('activeSigningAddress'), signerAddress)
		assert.equal(settings.activeSigningSafeAddress, undefined)

		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Current-chain Safe with signer address',
			address: signerAddress,
			chainId: activeChainId,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await activateAddressSelection(simulationServicesOwner, new Map(), { type: 'signer', address: signerAddress }, {
			simulationMode: false,
			signerAddress,
			promptForAccessesIfNeeded: false,
		})
		assert.equal(readStoredValue('activeSigningAddress'), signerAddress)
		assert.equal((await getSettings()).activeSigningSafeAddress, undefined)
	})

	test('clears a stale signing-mode Safe when the popup selects a disconnected signer', async () => {
		installBrowserMock()
		const {
			changeActiveAddress,
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const safeAddress = 0x4040404040404040404040404040404040404040n
		const previousOwner = 0x4141414141414141414141414141414141414141n
		const tabId = 198
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: previousOwner, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Disconnected Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [previousOwner],
		}])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [], activeSigningAddress: undefined }))
		await saveCurrentTabId(tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: 'signer', simulationMode: false },
		})

		const settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal(await getActiveAddress(settings, tabId), undefined)
	})

	test('remembers whether a signer account last selected its Safe or the external EOA', async () => {
		installBrowserMock()
		const {
			changeActiveAddress,
			changeSimulationMode,
			getSigningAddressPreferences,
			saveCurrentTabId,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const signerAddress = 0x4242424242424242424242424242424242424242n
		const safeAddress = 0x4343434343434343434343434343434343434343n
		const tabId = 200
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: signerAddress })
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Signer Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [signerAddress], activeSigningAddress: signerAddress }))
		await saveCurrentTabId(tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: safeAddress, simulationMode: false },
		})
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress, selection: 'safe', safeAddress, chainId: 1n }])

		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: 'signer', simulationMode: false },
		})
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress, selection: 'signer' }])
	})

	test('delivers accountsChanged before an approved active-address switch resolves', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousAccount = 0x1111111111111111111111111111111111111111n
		const nextAccount = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousAccount, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: previousAccount, access: true }, { address: nextAccount, access: true }],
		}])

		const socket = { tabId: 171, connectionName: 171n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: true,
			activeAddress: nextAccount,
		})

		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged'])
		assert.deepEqual(messages.find((message) => message.method === 'accountsChanged')?.result, ['0x2222222222222222222222222222222222222222'])
	})

	test('advertises the signer account when switching from a Safe to the MetaMask address', async () => {
		// The signer refresh only reaches website tabs that still exist, so this test opens its tab 173.
		installBrowserMock({ tabs: [{ id: 173 }] })
		const {
			changeActiveAddress,
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x2323232323232323232323232323232323232323n
		const signerAddress = 0x2424242424242424242424242424242424242424n
		const socket = { tabId: 173, connectionName: 0n }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress: signerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: safeAddress, access: true }, { address: signerAddress, access: true }],
		}])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		await saveCurrentTabId(socket.tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			accountReply = handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 403, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(signerAddress)], requestAccounts: false }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])

		await changeActiveAddress(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: 'signer', simulationMode: false },
		})
		await accountReply

		const accountChanges = messages.filter((message) => message.method === 'accountsChanged')
		assert.equal(accountChanges.length > 0, true)
		assert.deepEqual(accountChanges.at(-1)?.result, [addressString(signerAddress)])
		const settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, safeAddress)
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, signerAddress)
	})

	test('clears dapp accounts and finishes opening access approval when the active address is unapproved', async () => {
		installBrowserMock()
		const {
			changeActiveAddressAndChain,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			clearPendingAccessRequests,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousAccount = 0x3333333333333333333333333333333333333333n
		const nextAccount = 0x4444444444444444444444444444444444444444n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousAccount, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: previousAccount, access: true }],
		}])

		const socket = { tabId: 172, connectionName: 172n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: true,
			activeAddress: nextAccount,
		})

		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'disconnect'])
		assert.deepEqual(messages[0]?.result, [])
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		const pendingRequest = (await getPendingAccessRequests()).find((request) => request.requestAccessToAddress?.address === nextAccount)
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, nextAccount)
		await resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Rejected',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await clearPendingAccessRequests()
	})

	test('preserves the configured simulation address across a signing-mode round trip', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			enableSimulationMode,
			getSettings,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
		} = await loadModules()
		const simulationAddress = 0x6161616161616161616161616161616161616161n
		const signerAddress = 0x6262626262626262626262626262626262626262n
		const tabId = 197
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulationAddress, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateTabState(tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		await saveCurrentTabId(tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await enableSimulationMode(simulationServicesOwner, new Map(), {
			method: 'popup_enableSimulationMode',
			data: false,
		})
		const signingSettings = await getSettings()
		assert.equal(signingSettings.simulationMode, false)
		assert.equal(signingSettings.activeSimulationAddress, simulationAddress)
		assert.equal(signingSettings.activeSigningSafeAddress, undefined)
		assert.equal(signingSettings.useSignersAddressAsActiveAddress, false)
		await enableSimulationMode(simulationServicesOwner, new Map(), {
			method: 'popup_enableSimulationMode',
			data: true,
		})

		const settings = await getSettings()
		assert.equal(settings.simulationMode, true)
		assert.equal(settings.activeSimulationAddress, simulationAddress)
		assert.equal(settings.useSignersAddressAsActiveAddress, false)
	})

	test('restores the simulation signer after selecting a Safe in signing mode', async () => {
		installBrowserMock()
		const {
			changeActiveAddress,
			changeSimulationMode,
			enableSimulationMode,
			getSettings,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const signerAddress = 0x6868686868686868686868686868686868686868n
		const safeAddress = 0x6969696969696969696969696969696969696969n
		const tabId = 198
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: signerAddress })
		await setUseSignersAddressAsActiveAddress(true, signerAddress)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Signer-owned Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await updateTabState(tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		await saveCurrentTabId(tabId)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await enableSimulationMode(simulationServicesOwner, new Map(), {
			method: 'popup_enableSimulationMode',
			data: false,
		}, { passiveReplyTimeoutMs: 10 })
		await changeActiveAddress(simulationServicesOwner, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: safeAddress, simulationMode: false },
		})
		let settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, safeAddress)
		assert.equal(settings.activeSimulationAddress, signerAddress)

		await enableSimulationMode(simulationServicesOwner, new Map(), {
			method: 'popup_enableSimulationMode',
			data: true,
		}, { passiveReplyTimeoutMs: 10 })
		settings = await getSettings()
		assert.equal(settings.activeSimulationAddress, signerAddress)
		assert.equal(settings.activeSigningSafeAddress, safeAddress)
	})

	test('keeps simulation and Safe signing addresses independent across mode switches', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			enableSimulationMode,
			getActiveAddress,
			getSettings,
			getTabState,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const simulationAddress = 0x7070707070707070707070707070707070707070n
		const safeAddress = 0x7171717171717171717171717171717171717171n
		const safeSignerAddress = 0x7272727272727272727272727272727272727272n
		const socket = { tabId: 1, connectionName: 0n }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulationAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [0x7373737373737373737373737373737373737373n],
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		await saveCurrentTabId(socket.tabId)

		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await enableSimulationMode(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		}, { passiveReplyTimeoutMs: 10 })

		const settings = await getSettings()
		assert.equal(settings.simulationMode, false)
		assert.equal(settings.activeSimulationAddress, simulationAddress)
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, safeSignerAddress)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)

		await updateUserAddressBookEntries((entries) => entries.map((entry) => entry.type === 'safe' ? { ...entry, safeSignerAddresses: [safeSignerAddress] } : entry))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulationAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await enableSimulationMode(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		}, { passiveReplyTimeoutMs: 10 })

		const ownedSafeSettings = await getSettings()
		assert.equal(ownedSafeSettings.simulationMode, false)
		assert.equal(ownedSafeSettings.activeSimulationAddress, simulationAddress)
		assert.equal(ownedSafeSettings.activeSigningSafeAddress, safeAddress)
		assert.equal((await getActiveAddress(ownedSafeSettings, socket.tabId))?.address, safeAddress)

		await enableSimulationMode(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: true,
		})
		const restoredSimulationSettings = await getSettings()
		assert.equal(restoredSimulationSettings.activeSimulationAddress, simulationAddress)
		assert.equal(restoredSimulationSettings.activeSigningSafeAddress, safeAddress)
		await enableSimulationMode(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		})
		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)

		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [], activeSigningAddress: undefined }))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulationAddress, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await enableSimulationMode(simulationServicesOwner, new Map(), {
			method: 'popup_enableSimulationMode',
			data: false,
		})

		const noSignerSettings = await getSettings()
		assert.equal(noSignerSettings.simulationMode, false)
		assert.equal(noSignerSettings.activeSimulationAddress, simulationAddress)
		assert.equal((await getTabState(socket.tabId)).activeSigningAddress, undefined)
		assert.equal(noSignerSettings.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(noSignerSettings, socket.tabId)), undefined)
	})

	test('switching a Safe to signing mode refreshes only the current signer tab', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			enableSimulationMode,
			getActiveAddress,
			getSettings,
			getSigningAddressPreferences,
			handleInterceptedRequest,
			saveCurrentTabId,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x7373737373737373737373737373737373737373n
		const safeSignerAddress = 0x7474747474747474747474747474747474747474n
		const currentSocket = { tabId: 1, connectionName: 0n }
		const unrelatedSocket = { tabId: 2, connectionName: 0n }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [safeSignerAddress],
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])
		for (const tabId of [currentSocket.tabId, unrelatedSocket.tabId]) {
			await updateTabState(tabId, (previousState) => ({
				...previousState,
				signerAccounts: [safeSignerAddress],
				activeSigningAddress: safeSignerAddress,
				signerChain: 1n,
			}))
		}
		await saveCurrentTabId(currentSocket.tabId)

		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port: currentPort, messages: currentMessages } = createPort(currentSocket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			accountReply = handleInterceptedRequest(currentPort, websiteOrigin, website, simulationServicesOwner, currentSocket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 401, requestSocket: currentSocket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(safeSignerAddress)], requestAccounts: false }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const { port: unrelatedPort, messages: unrelatedMessages } = createPort(unrelatedSocket.tabId)
		websiteTabConnections = new Map([
			[currentSocket.tabId, { ...confirmedSignerOwnership(currentSocket), connections: {
				[websiteSocketToString(currentSocket)]: { port: currentPort, socket: currentSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
			[unrelatedSocket.tabId, { ...confirmedSignerOwnership(unrelatedSocket), connections: {
				[websiteSocketToString(unrelatedSocket)]: { port: unrelatedPort, socket: unrelatedSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
		])

		await enableSimulationMode(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		})
		await accountReply

		const signingSettings = await getSettings()
		assert.equal(signingSettings.simulationMode, false)
		assert.equal((await getActiveAddress(signingSettings, currentSocket.tabId))?.address, safeAddress)
		assert.deepEqual(await getSigningAddressPreferences(), [{
			signerAddress: safeSignerAddress,
			selection: 'safe',
			safeAddress,
			chainId: 1n,
		}])
		assert.equal(currentMessages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
		assert.equal(unrelatedMessages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
	})
})
