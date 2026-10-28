import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

describe('background access dialog address policy', () => {
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
		const originalEntry: AddressBookEntry = { type: 'contact', name: 'Original', address: originalAddress, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }
		const selfOwnedSafe: AddressBookEntry = { type: 'safe', name: 'Self-owned Safe', address: safeAndSignerAddress, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [safeAndSignerAddress] }
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
		const signerEntry: AddressBookEntry = { type: 'contact', name: 'Signer', address, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }
		const selfOwnedSafe: AddressBookEntry = { type: 'safe', name: 'Self-owned Safe', address, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [address] }
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

		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await resolveInterceptorAccess(simulationServicesOwner, new Map(), {
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		const safeEntry: AddressBookEntry = {
			type: 'safe',
			name: 'Owned Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const approve = async () => await resolveInterceptorAccess(simulationServicesOwner, new Map(), {
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

	test('stored websites without an active decision remain promptable instead of denied', async () => {
		installBrowserMock()
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const address: AddressBookEntry = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address', entrySource: 'User' }

		assert.equal(hasAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin, address), 'askAccess')
		assert.equal(hasAccess([], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([], websiteOrigin, address), 'askAccess')
	})

	test('verifyAccess requires an address decision despite website approval', async () => {
		installBrowserMock()
		const { getSettings, updateWebsiteAccess, verifyAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const address: AddressBookEntry = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address', entrySource: 'User' }
		const socket = { tabId: 1, connectionName: 0n }
		const websiteTabConnections: WebsiteTabConnections = new Map()
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])
		const settings = await getSettings()

		assert.equal(verifyAccess(websiteTabConnections, socket, true, websiteOrigin, address, settings), 'askAccess')

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: address.address, access: false }] }])
		assert.equal(verifyAccess(websiteTabConnections, socket, true, websiteOrigin, address, await getSettings()), 'noAccess')
	})
})
