import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

describe('background eth_accounts', () => {
	test('refreshes the cached signing visualization when selecting another Safe on the same chain', async () => {
		installBrowserMock()
		const messages: unknown[] = []
		Object.defineProperty(browser.runtime, 'sendMessage', {
			configurable: true,
			value: async (message: unknown) => {
				messages.push(message)
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') {
					return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: false } }
				}
				return undefined
			},
		})
		const { changeActiveAddressAndChain, changeSimulationMode, getSettings } = await loadModules()
		const firstSafe = 0x1010101010101010101010101010101010101010n
		const secondSafe = 0x2020202020202020202020202020202020202020n
		await changeSimulationMode({ simulationMode: false, activeSigningSafeAddress: firstSafe })
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			simulationMode: false,
			activeAddress: secondSafe,
			signingAddressSelection: 'safe',
			promptForAccessesIfNeeded: false,
		})

		assert.equal((await getSettings()).activeSigningSafeAddress, secondSafe)
		assert.equal(messages.some((message) =>
			typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen'
		), true)
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: arbitraryEoa, simulationMode: false },
		})
		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: unownedSafe, simulationMode: false },
		})
		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		assert.deepEqual(
			await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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
		await activateAddressSelection(ethereum, tokenPriceService, resetSimulationServices, new Map(), { type: 'signer', address: signerAddress }, {
			simulationMode: false,
			signerAddress,
			promptForAccessesIfNeeded: false,
		})
		assert.equal(readStoredValue('activeSigningAddress'), signerAddress)
		assert.equal((await getSettings()).activeSigningSafeAddress, undefined)
	})

	test('keeps a newly selected self-owned Safe distinct from its signer EOA in the access dialog', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingAccessRequests,
			requestAddressChange,
			updatePendingAccessRequests,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const safeAndSignerAddress = 0x5151515151515151515151515151515151515151n
		const originalAddress = 0x5252525252525252525252525252525252525252n
		const originalEntry = { type: 'contact' as const, name: 'Original', address: originalAddress, entrySource: 'User' as const, useAsActiveAddress: true, askForAddressAccess: true }
		const selfOwnedSafe = { type: 'safe' as const, name: 'Self-owned Safe', address: safeAndSignerAddress, chainId: 1n, entrySource: 'User' as const, useAsActiveAddress: true, safeSignerAddresses: [safeAndSignerAddress] }
		const tabId = 196
		const socket = { tabId, connectionName: 0n }
		const website = { websiteOrigin: 'https://self-owned-safe.example', icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: safeAndSignerAddress, activeSigningSafeAddress: undefined })
		await updateUserAddressBookEntries(() => [originalEntry, selfOwnedSafe])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [safeAndSignerAddress], activeSigningAddress: safeAndSignerAddress }))
		await updatePendingAccessRequests(async () => [{
			website,
			requestAccessToAddress: originalEntry,
			originalRequestAccessToAddress: originalEntry,
			associatedAddresses: [],
			signerAccounts: [safeAndSignerAddress],
			signerName: 'MetaMask',
			simulationMode: false,
			popupOrTabId: { type: 'popup', id: 1 },
			socket,
			request: undefined,
			activeAddress: originalAddress,
			accessRequestId: 'self-owned-safe-selection',
		}])

		await requestAddressChange(new Map(), {
			method: 'popup_interceptorAccessChangeAddress',
			data: {
				socket,
				accessRequestId: 'self-owned-safe-selection',
				website,
				requestAccessToAddress: originalAddress,
				newActiveAddress: safeAndSignerAddress,
			},
		})

		assert.deepEqual((await getPendingAccessRequests())[0]?.requestAccessToAddress, selfOwnedSafe)
	})

	test('activates a self-owned Safe selected over its same-address signer EOA when access is approved', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingAccessRequests,
			getSettings,
			requestAddressChange,
			resolveInterceptorAccess,
			updatePendingAccessRequests,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const address = 0x5353535353535353535353535353535353535353n
		const signerEntry = { type: 'contact' as const, name: 'Signer', address, entrySource: 'User' as const, useAsActiveAddress: true, askForAddressAccess: true }
		const selfOwnedSafe = { type: 'safe' as const, name: 'Self-owned Safe', address, chainId: 1n, entrySource: 'User' as const, useAsActiveAddress: true, safeSignerAddresses: [address] }
		const tabId = 195
		const socket = { tabId, connectionName: 0n }
		const website = { websiteOrigin: 'https://same-address-safe.example', icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: address, activeSigningSafeAddress: undefined })
		await updateUserAddressBookEntries(() => [selfOwnedSafe])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [address], activeSigningAddress: address }))
		await updatePendingAccessRequests(async () => [{
			website,
			requestAccessToAddress: signerEntry,
			originalRequestAccessToAddress: signerEntry,
			associatedAddresses: [],
			signerAccounts: [address],
			signerName: 'MetaMask',
			simulationMode: false,
			popupOrTabId: { type: 'popup', id: 1 },
			socket,
			request: undefined,
			activeAddress: address,
			accessRequestId: 'same-address-safe-selection',
		}])

		await requestAddressChange(new Map(), {
			method: 'popup_interceptorAccessChangeAddress',
			data: {
				socket,
				accessRequestId: 'same-address-safe-selection',
				website,
				requestAccessToAddress: address,
				newActiveAddress: address,
			},
		})
		assert.deepEqual((await getPendingAccessRequests())[0]?.requestAccessToAddress, selfOwnedSafe)

		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			userReply: 'Approved',
			requestAccessToAddress: address,
			originalRequestAccessToAddress: address,
			accessRequestId: 'same-address-safe-selection',
		}, noopPublishRpcConnectionStatus)

		assert.equal((await getSettings()).activeSigningSafeAddress, address)
	})

	test('does not inherit wrong-chain address access policy during requests or access-dialog changes', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getPendingAccessRequests,
			getAddressMetadataForAccess,
			getSettings,
			hasAddressAccess,
			handleInterceptedRequest,
			requestAddressChange,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const activeAddress = 0x4242424242424242424242424242424242424242n
		const websiteOrigin = 'https://chain-scoped-metadata.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		await updateUserAddressBookEntries(() => [
			{ type: 'contact', name: 'Wrong-chain address', address: activeAddress, chainId: 10n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false },
		])

		const activeAddressEntry = await getActiveAddress(await getSettings(), 198)
		if (activeAddressEntry === undefined) throw new Error('Missing active simulation address metadata')
		assert.notEqual(activeAddressEntry.name, 'Wrong-chain address')
		assert.equal(activeAddressEntry.askForAddressAccess, true)
		assert.equal(hasAddressAccess([{
			website,
			access: true,
			addressAccess: [],
		}], websiteOrigin, activeAddressEntry), 'askAccess')

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])
		const socket = { tabId: 198, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 42, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing current-chain address access request')
		assert.notEqual(pendingRequest.requestAccessToAddress?.name, 'Wrong-chain address')
		assert.equal(pendingRequest.associatedAddresses.some((entry) => entry.name === 'Wrong-chain address'), false)
		assert.equal(messages.some((message) => message.method === 'eth_requestAccounts' && message.requestId === 42), false)
		assert.equal((await getAddressMetadataForAccess((await getSettings()).websiteAccess, 1n))[0]?.name === 'Wrong-chain address', false)

		await updateUserAddressBookEntries(() => [
			{ type: 'contact', name: 'Wrong-chain address', address: activeAddress, chainId: 10n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false },
			{ type: 'contact', name: 'Current-chain address', address: activeAddress, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
		])
		await requestAddressChange(websiteTabConnections, {
			method: 'popup_interceptorAccessChangeAddress',
			data: {
				socket,
				accessRequestId: pendingRequest.accessRequestId,
				website,
				requestAccessToAddress: activeAddress,
				newActiveAddress: activeAddress,
			},
		})
		assert.equal((await getPendingAccessRequests())[0]?.requestAccessToAddress?.name, 'Current-chain address')
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: 'signer', simulationMode: false },
		})

		const settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal(await getActiveAddress(settings, tabId), undefined)
	})

	test('falls back to the wallet account when a stored signing Safe is no longer owned', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://stale-safe.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x4545454545454545454545454545454545454545n
		const safeAddress = signerAddress
		const formerOwner = 0x4747474747474747474747474747474747474747n
		const socket = { tabId: 197, connectionName: 0n }
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'No longer owned Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [formerOwner],
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: signerAddress, access: true }] }])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))

		const settings = await getSettings()
		const activeAddress = await getActiveAddress(settings, socket.tabId)
		assert.equal(activeAddress?.address, signerAddress)
		assert.notEqual(activeAddress?.type, 'safe')

		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 12).at(-1)?.result, [addressString(signerAddress)])
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: safeAddress, simulationMode: false },
		})
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress, selection: 'safe', safeAddress, chainId: 1n }])

		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: 'signer', simulationMode: false },
		})
		assert.deepEqual(await getSigningAddressPreferences(), [{ signerAddress, selection: 'signer' }])
	})

	test('rechecks Safe ownership against the live signer when website access is approved', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
			setUseSignersAddressAsActiveAddress,
			updatePendingAccessRequests,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
		} = await loadModules()
		const safeAddress = 0x5151515151515151515151515151515151515151n
		const ownerAtPrompt = 0x6161616161616161616161616161616161616161n
		const ownerAtApproval = 0x7171717171717171717171717171717171717171n
		const tabId = 201
		const socket = { tabId, connectionName: 0n }
		const website = { websiteOrigin: 'https://safe-owner-change.example', icon: undefined, title: undefined }
		const safeEntry = {
			type: 'safe' as const,
			name: 'Owned Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User' as const,
			useAsActiveAddress: true,
			safeSignerAddresses: [ownerAtPrompt],
		}
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: ownerAtApproval })
		await setUseSignersAddressAsActiveAddress(true, ownerAtApproval)
		await updateWebsiteAccess(() => [])
		await updateUserAddressBookEntries(() => [safeEntry])
		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [ownerAtApproval], activeSigningAddress: ownerAtApproval }))
		await updatePendingAccessRequests(async () => [{
			website,
			requestAccessToAddress: safeEntry,
			originalRequestAccessToAddress: safeEntry,
			associatedAddresses: [],
			signerAccounts: [ownerAtPrompt],
			signerName: 'MetaMask',
			simulationMode: false,
			popupOrTabId: { type: 'popup', id: 1 },
			socket,
			request: undefined,
			activeAddress: safeAddress,
			accessRequestId: 'safe-owner-changed-before-approval',
		}])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const approve = async () => await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			userReply: 'Approved',
			requestAccessToAddress: safeAddress,
			originalRequestAccessToAddress: safeAddress,
			accessRequestId: 'safe-owner-changed-before-approval',
		}, noopPublishRpcConnectionStatus)

		await assert.rejects(approve, /not available for the current signing wallet/)
		assert.equal((await getSettings()).websiteAccess.some((entry) => entry.website.websiteOrigin === website.websiteOrigin), false)
		assert.equal((await getPendingAccessRequests()).length, 1)

		await updateTabState(tabId, (previousState) => ({ ...previousState, signerAccounts: [ownerAtPrompt], activeSigningAddress: ownerAtPrompt }))
		await approve()
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === website.websiteOrigin)
		assert.deepEqual(access?.addressAccess, [{ address: safeAddress, access: true }])
	})

	test('replays account state after already-approved eth_requestAccounts with cached active signer address', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4an
		const accountString = '0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [11])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
	})

	test('replays account state for already-approved eth_requestAccounts on signer-only networks', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn
		const accountString = '0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c'
		await changeSimulationMode({
			simulationMode: false,
			rpcNetwork: {
				name: 'Signer only',
				chainId: 1n,
				httpsRpc: undefined,
				currencyName: 'Ether?',
				currencyTicker: 'ETH?',
				primary: false,
				minimized: true,
			},
			activeSimulationAddress: undefined,
			activeSigningAddress: account,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 16, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 16)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [16])
		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
	})

	test('does not expose an active address in connected_to_signer replies', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4bn
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 2],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const connectedReplies = messages.filter((message) => message.method === 'connected_to_signer' && message.requestId === 12)
		assert.deepEqual(connectedReplies.at(-1)?.result, { metamaskCompatibilityMode: false })
	})

	test('requires visible address consent after signer discovery for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5555555555555555555555555555555555555555n
		const accountString = '0x5555555555555555555555555555555555555555'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 10), [])
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(pendingRequest.signerAccounts, [account])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 10).map((message) => message.result), [[accountString]])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not override an explicitly denied address for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5656565656565656565656565656565656565656n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: false }] }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 22, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'connect' || message.method === 'accountsChanged'), false)
		assert.equal(messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 22).at(-1)?.error?.code, 4100)
		assert.equal((await getPendingAccessRequests()).length, 0)
	})

	test('does not approve the port before site-approved eth_requestAccounts receives address consent', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const pendingWebsite = createDeferredValue<typeof website>()
		const account = 0x5757575757575757575757575757575757575757n
		const accountString = '0x5757575757575757575757575757575757575757'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const requestAccountsPromise = handleInterceptedRequest(port, websiteOrigin, pendingWebsite.promise, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 23, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 24, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 24).map((message) => message.result), [[]])
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		pendingWebsite.resolve(website)
		await requestAccountsPromise

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.equal(connection.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 23), [])
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, true)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 23).map((message) => message.result), [[accountString]])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not overwrite an address denial made while site-approved eth_requestAccounts is pending', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const pendingWebsite = createDeferredValue<typeof website>()
		const account = 0x5858585858585858585858585858585858585858n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const requestAccountsPromise = handleInterceptedRequest(port, websiteOrigin, pendingWebsite.promise, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 25, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: false }] }])
		pendingWebsite.resolve(website)
		await requestAccountsPromise

		assert.equal(connection.approved, false)
		assert.equal(messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 25).at(-1)?.error?.code, 4100)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: false }])
	})

	test('uses wallet metadata for cached signer address consent when a same-address Safe exists', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			updateUserAddressBookEntries,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6666666666666666666666666666666666666666n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Same-address Safe',
			address: account,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [account],
		}])
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerAccounts: [account],
			activeSigningAddress: undefined,
			signerAccountError: { code: 4900, message: 'Stale signer error' },
		}))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.notEqual(pendingRequest.requestAccessToAddress?.type, 'safe')

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [['0x6666666666666666666666666666666666666666']])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11).at(-1)?.result, ['0x6666666666666666666666666666666666666666'])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('reuses a persisted access dialog when the same eth_requestAccounts is replayed after restart', async () => {
		installBrowserMock()
		const {
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
		} = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const firstWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-before-restart')
		const restartedWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-after-restart')
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6677667766776677667766776677667766776677n
		const accountString = '0x6677667766776677667766776677667766776677'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 111, requestSocket: socket },
			method: 'eth_requestAccounts',
		} as const
		const requestAccessToAddress = await getActiveAddressEntryForChain(account, 1n)
		const settings = await getSettings()

		await firstWorkerAccess.requestAccessFromUser(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			noopPublishRpcConnectionStatus,
		)
		await restartedWorkerAccess.requestAccessFromUser(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			noopPublishRpcConnectionStatus,
		)

		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal(messages.some((message) => message.requestId === 111), false)
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request after worker restart')
		await restartedWorkerAccess.resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 111).map((message) => message.result), [[accountString]])
	})

	test('uses refreshed website access after signer account discovery', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7777777777777777777777777777777777777777n
		const accountString = '0x7777777777777777777777777777777777777777'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 101, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 12)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('does not connect an unapproved port when signer rejects site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 13)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
	})

	test('does not connect an unapproved port when signer returns empty accounts for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 103, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 14)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('preserves the signer account-access rejection for approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 8)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('maps unavailable signer errors only for interactive account connection methods', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const unavailableSignerError = {
			code: 4900,
			message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.',
		}
		const account = 0x2424242424242424242424242424242424242424n
		const accountString = '0x2424242424242424242424242424242424242424'
		const accountRequests = [
			{ method: 'eth_requestAccounts', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'wallet_requestPermissions', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'eth_accounts', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
			{ method: 'wallet_getPermissions', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
			{ method: 'wallet_getCapabilities', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4100, requestAccounts: false },
		] as const
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		let internalRequestId = 104
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			const accountRequest = accountRequests.find((candidate) => candidate.signerRequestMethod === message.method)
			if (accountRequest === undefined) return
			internalRequestId += 1
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId: internalRequestId, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: accountRequest.requestAccounts, signerUnavailable: true, error: unavailableSignerError }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [requestIndex, accountRequest] of accountRequests.entries()) {
			const requestId = 15 + requestIndex
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: accountRequest.method,
				...(accountRequest.method === 'wallet_getCapabilities' ? { params: [accountString] } : {}),
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const replies = messages.filter((message) => message.method === accountRequest.method && message.requestId === requestId)
			assert.equal(replies.length, 1)
			assert.deepEqual(
				replies[0]?.error,
				accountRequest.method === 'wallet_getCapabilities'
					? { code: 4100, message: 'The requested method and/or account has not been authorized by the user.' }
					: { ...unavailableSignerError, code: accountRequest.expectedPublicErrorCode },
			)
			assert.equal(messages.some((message) => (message.method === 'connect' || message.method === 'accountsChanged') && message.requestId === requestId), false)
		}
		assert.equal((await getTabState(socket.tabId)).signerAccountError, undefined)
	})

	test('ignores a provider-disconnected completion from a sibling socket', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			sendInternalWindowMessage,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2424242424242424242424242424242424242424n
		const accountString = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		const requestPromise = handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1)
		sendInternalWindowMessage({
			method: 'window_signer_accounts_changed',
			data: {
				socket: siblingSocket,
				signerStateOwnerGeneration: 1,
				signerProviderGeneration: 1,
				error: { code: 4900, message: 'Sibling signer is unavailable' },
			},
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(messages.some((message) => message.requestId === 18), false)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 105, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await requestPromise

		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18)
		assert.equal(requestAccountsReplies.length, 1)
		assert.deepEqual(requestAccountsReplies[0]?.result, [accountString])
	})

	test('keeps sibling connection events when address consent resolves eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6868686868686868686868686868686868686868n
		const accountString = '0x6868686868686868686868686868686868686868'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18), [])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged'), [])

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestLifecycleMessages = messages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(requestLifecycleMessages.map((message) => message.method), ['accountsChanged'])
		assert.deepEqual(requestLifecycleMessages.map((message) => message.requestId), [18])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18).at(-1)?.result, [accountString])
		const siblingLifecycleMessages = siblingMessages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.method), ['connect', 'accountsChanged', 'chainChanged'])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.requestId), [undefined, undefined, undefined])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.result), [['0x1'], [accountString], '0x1'])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('falls back to the pending request address when popup approval reply omits address fields', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6969696969696969696969696969696969696969n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 21, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('popup-approved wallet_requestPermissions stores address access and returns restrictReturnedAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 22, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 22).at(-1)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('simulation-mode wallet_requestPermissions requires address consent for a site-only approval', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7171717171717171717171717171717171717171n
		const accountString = '0x7171717171717171717171717171717171717171'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 24, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 24), [])

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [24])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 24).at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not bypass access for wallet_requestPermissions with unsupported permission keys', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7474747474747474747474747474747474747474n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 26, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {}, wallet_snap: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, false)
		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)
	})

	test('first-time wallet_requestPermissions uses one dialog that identifies the address', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 230, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 23, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const siteLevelPendingRequest = (await getPendingAccessRequests())[0]
		if (siteLevelPendingRequest === undefined) throw new Error('Missing combined site and address access request')
		assert.equal(siteLevelPendingRequest.requestAccessToAddress?.address, account)
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: account,
				originalRequestAccessToAddress: account,
				accessRequestId: siteLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		assert.equal((await getPendingAccessRequests()).length, 0)
		await waitForPortMessageCount(messages, 'wallet_requestPermissions', 1)
		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 23).at(-1)
		assert.equal(permissionReply?.error, undefined)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('site-approved wallet_requestPermissions opens address consent after releasing the popup semaphore', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			requestAccessFromUser,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7373737373737373737373737373737373737373n
		const accountString = '0x7373737373737373737373737373737373737373'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 731, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 73, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await Promise.race([
			requestAccessFromUser(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				socket,
				website,
				request,
				undefined,
				await getSettings(),
				undefined,
				noopPublishRpcConnectionStatus,
			),
			new Promise((_, reject) => setTimeout(() => reject(new Error('requestAccessFromUser did not resolve')), 100)),
		])

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(messages.some((message) => message.method === 'wallet_requestPermissions' && message.requestId === 73 && message.error?.code === -32002), false)
		assert.equal(pendingRequests.length, 1)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)

		await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 73).at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: true,
			activeAddress: nextAccount,
		})

		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged'])
		assert.deepEqual(messages[0]?.result, ['0x2222222222222222222222222222222222222222'])
	})

	test('advertises the signer account when switching from a Safe to the MetaMask address', async () => {
		installBrowserMock()
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			accountReply = handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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
			ethereum,
			tokenPriceService,
			resetSimulationServices,
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

	test('wallet_revokePermissions clears website account access and keeps the website entry', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const accessLossEvents = messages.filter((message) => message.method === 'accountsChanged' || message.method === 'disconnect')
		assert.deepEqual(accessLossEvents.map((message) => message.method), ['accountsChanged', 'disconnect'])
		assert.deepEqual(accessLossEvents[0]?.result, [])
		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 10)
		assert.equal(revokeReplies.at(-1)?.result, null)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
	})

	test('wallet_revokePermissions succeeds when the website is already unauthorized', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings, getPendingAccessRequests } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 11)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, false)
		assert.equal(access?.addressAccess, undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 0)
	})

	test('wallet_revokePermissions succeeds when the Interceptor is disabled for the website', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }], interceptorDisabled: true }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 12)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
		assert.equal(access?.interceptorDisabled, true)
	})

	test('wallet_revokePermissions causes later account requests to prompt again instead of auto-denying', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getPendingAccessRequests, updateWebsiteApprovalAccesses, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.wantsToConnect, false)
		await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
		assert.equal((await getPendingAccessRequests()).length, 0)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.website.websiteOrigin, websiteOrigin)
	})

	test('wallet_revokePermissions rejects unsupported permission params without revoking access', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const unsupportedParams: unknown[] = [
			[],
			[{ wallet_switchEthereumChain: {} }],
			[{ wallet_snap: {} }],
			[{ eth_accounts: {}, wallet_snap: {} }],
			[{ eth_accounts: { foo: 1 } }],
		]
		for (const [index, params] of unsupportedParams.entries()) {
			const requestId = 13 + index
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'wallet_revokePermissions',
				params,
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === requestId)
			assert.equal(revokeReplies.at(-1)?.error?.code, -32700)
			assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, true)
			const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
			assert.equal(access?.access, true)
			assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
		}
	})

	test('stored websites without an active decision remain promptable instead of denied', async () => {
		installBrowserMock()
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const address = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address' } as const

		assert.equal(hasAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin, address), 'askAccess')
		assert.equal(hasAccess([], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([], websiteOrigin, address), 'askAccess')
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_enableSimulationMode',
			data: false,
		})
		const signingSettings = await getSettings()
		assert.equal(signingSettings.simulationMode, false)
		assert.equal(signingSettings.activeSimulationAddress, simulationAddress)
		assert.equal(signingSettings.activeSigningSafeAddress, undefined)
		assert.equal(signingSettings.useSignersAddressAsActiveAddress, false)
		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_enableSimulationMode',
			data: false,
		}, { passiveReplyTimeoutMs: 10 })
		await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: safeAddress, simulationMode: false },
		})
		let settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, safeAddress)
		assert.equal(settings.activeSimulationAddress, signerAddress)

		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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
		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		}, { passiveReplyTimeoutMs: 10 })

		const ownedSafeSettings = await getSettings()
		assert.equal(ownedSafeSettings.simulationMode, false)
		assert.equal(ownedSafeSettings.activeSimulationAddress, simulationAddress)
		assert.equal(ownedSafeSettings.activeSigningSafeAddress, safeAddress)
		assert.equal((await getActiveAddress(ownedSafeSettings, socket.tabId))?.address, safeAddress)

		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: true,
		})
		const restoredSimulationSettings = await getSettings()
		assert.equal(restoredSimulationSettings.activeSimulationAddress, simulationAddress)
		assert.equal(restoredSimulationSettings.activeSigningSafeAddress, safeAddress)
		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_enableSimulationMode',
			data: false,
		})
		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)

		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [], activeSigningAddress: undefined }))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulationAddress, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
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

	test('does not apply the passive reply timeout to interactive signer approval', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getTabState,
			handleInterceptedRequest,
			refreshSignerAccountsForTab,
			setUseSignersAddressAsActiveAddress,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x7575757575757575757575757575757575757575n
		const socket = { tabId: 1, connectionName: 0n }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			accountReply = new Promise((resolve) => {
				setTimeout(() => {
					resolve(handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
						interceptorRequest: true,
						interceptorInternalRequest: true,
						usingInterceptorWithoutSigner: false,
						uniqueRequestIdentifier: { requestId: 402, requestSocket: socket },
						method: 'eth_accounts_reply',
						params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(signerAddress)], requestAccounts: true }],
					}, websiteTabConnections, noopPublishRpcConnectionStatus))
				}, 20)
			})
		})
		websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])

		await refreshSignerAccountsForTab(websiteTabConnections, socket.tabId, true, { passiveReplyTimeoutMs: 1 })
		await accountReply

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [signerAddress])
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

		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port: currentPort, messages: currentMessages } = createPort(currentSocket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			accountReply = handleInterceptedRequest(currentPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, currentSocket, {
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

		await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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

	test('verifyAccess requires an address decision despite website approval', async () => {
		installBrowserMock()
		const { getSettings, updateWebsiteAccess, verifyAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const address = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address' } as const
		const socket = { tabId: 1, connectionName: 0n }
		const websiteTabConnections: WebsiteTabConnections = new Map()
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])
		const settings = await getSettings()

		assert.equal(verifyAccess(websiteTabConnections, socket, true, websiteOrigin, address, settings), 'askAccess')

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: address.address, access: false }] }])
		assert.equal(verifyAccess(websiteTabConnections, socket, true, websiteOrigin, address, await getSettings()), 'noAccess')
	})
})
