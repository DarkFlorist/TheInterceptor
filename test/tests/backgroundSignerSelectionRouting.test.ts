import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { authorizeSocketForSignerExecution, reconcileSignerExecutionDocument, registerCurrentChildSignerSocket, setSignerExecutionTarget } from '../../app/ts/background/signerExecutionAuthority.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const ADDRESS_PROMPT_TIMEOUT_MS = 2_000

describe('background signer selection routing', () => {
	test('blocks simulated wallet_watchAsset requests until the child frame acknowledges the selected provider', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: 0x1111111111111111111111111111111111111111n })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: 0x1111111111111111111111111111111111111111n, access: true }] }])

		const topSocket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 2n }
		const providerUuid = '22222222-2222-4222-8222-222222222222'
		registerCurrentChildSignerSocket(childSocket, 2)
		reconcileSignerExecutionDocument(childSocket, websiteOrigin, '11111111-1111-4111-8111-111111111111', false, 2)
		setSignerExecutionTarget(childSocket.tabId, providerUuid, websiteOrigin)

		const top = createPort(topSocket.tabId, undefined, 0, topSocket.connectionName)
		const child = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const websiteTabConnections: WebsiteTabConnections = new Map([[childSocket.tabId, { ...confirmedSignerOwnership(topSocket), connections: {
			[websiteSocketToString(topSocket)]: { port: top.port, socket: topSocket, websiteOrigin, frameId: 0, approved: true, wantsToConnect: true },
			[websiteSocketToString(childSocket)]: { port: child.port, socket: childSocket, websiteOrigin, frameId: 2, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: childSocket },
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC20', options: { address: '0x1111111111111111111111111111111111111111', chainId: 2 } }],
		} as const

		await handleInterceptedRequest(child.port, websiteOrigin, website, simulationServicesOwner, childSocket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal(child.messages.at(-1)?.error?.code, 4100)

		assert.equal(authorizeSocketForSignerExecution(childSocket, providerUuid, websiteOrigin), true)
		await handleInterceptedRequest(child.port, websiteOrigin, website, simulationServicesOwner, childSocket, {
			...request,
			uniqueRequestIdentifier: { ...request.uniqueRequestIdentifier, requestId: 2 },
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal(child.messages.at(-1)?.error?.code, -32602)
	})

	test('treats an omitted content-script frameId as the top frame for provider catalogs and popup selection', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, getTabState, updateTabState, websiteSocketToString } = await loadModules()
		const { selectSignerProvider } = await import('../../app/ts/background/signerProviderSelection.js')
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: 'Example' }
		const provider = {
			uuid: '22222222-2222-4222-8222-222222222222',
			name: 'Example Wallet',
			icon: 'data:image/svg+xml,<svg/>',
			rdns: 'com.example.wallet',
		}
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, website }))

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'signer_providers_changed',
			params: [[provider], false, '11111111-1111-4111-8111-111111111111'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual((await getTabState(socket.tabId)).availableSignerProviders, [provider])
		await selectSignerProvider(websiteTabConnections, {
			method: 'popup_selectSignerProvider',
			data: { tabId: socket.tabId, websiteOrigin, uuid: provider.uuid },
		})
		assert.equal(messages.filter((message) => message.method === 'select_signer_provider').length, 1)
	})

	test('access refresh reuses top metadata for same-origin children without leaking it cross-origin', async () => {
		installBrowserMock({ tabStatus: 'loading' })
		const { changeSimulationMode, getPendingAccessRequests, getSettings, setUseSignersAddressAsActiveAddress, updateTabState, updateWebsiteAccess, updateWebsiteApprovalAccesses, websiteSocketToString } = await loadModules()
		const sameOrigin = 'https://example.test'
		const crossOrigin = 'https://frame.test'
		const account = 0x1111111111111111111111111111111111111111n
		const cachedWebsite = { websiteOrigin: sameOrigin, icon: undefined, title: 'Cached top-frame title' }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateTabState(1, (previousState) => ({ ...previousState, website: cachedWebsite }))
		await updateWebsiteAccess(() => [
			{ website: cachedWebsite, access: true, addressAccess: undefined },
			{ website: { websiteOrigin: crossOrigin, icon: undefined, title: 'Untrusted frame title' }, access: true, addressAccess: undefined },
		])

		const sameOriginSocket = { tabId: 1, connectionName: 2n }
		const crossOriginSocket = { tabId: 1, connectionName: 3n }
		const websiteTabConnections = new Map([[1, { connections: {
			[websiteSocketToString(sameOriginSocket)]: { port: createPort(1).port, socket: sameOriginSocket, websiteOrigin: sameOrigin, frameId: 2, approved: false, wantsToConnect: true },
			[websiteSocketToString(crossOriginSocket)]: { port: createPort(1).port, socket: crossOriginSocket, websiteOrigin: crossOrigin, frameId: 3, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const metadataTimeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Child access refresh waited for the loading tab')), ADDRESS_PROMPT_TIMEOUT_MS))
		await Promise.race([
			updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true),
			metadataTimeout,
		])

		const pendingRequests = await getPendingAccessRequests()
		const sameOriginRequest = pendingRequests.find((request) => request.website.websiteOrigin === sameOrigin)
		const crossOriginRequest = pendingRequests.find((request) => request.website.websiteOrigin === crossOrigin)
		assert.equal(sameOriginRequest?.website.title, cachedWebsite.title)
		assert.equal(crossOriginRequest?.website.title, undefined)
		assert.equal(crossOriginRequest?.website.icon, undefined)
	})
})
