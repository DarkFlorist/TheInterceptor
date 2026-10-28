import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { PopupOrTabId } from '../../app/ts/types/websiteAccessTypes.js'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'
import { ERROR_INTERCEPTOR_DISABLED, METAMASK_ERROR_NOT_AUTHORIZED } from '../../app/ts/utils/constants.js'
import type { InterceptedRequest, WebsiteSocket } from '../../app/ts/utils/requests.js'
import { type BackgroundBrowserMock, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { readProperty } from '../harness/assertions.js'
import { settleWithin } from '../harness/async.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const createSettings = (activeSimulationAddress: bigint | undefined): Settings => ({
	activeSimulationAddress,
	activeSigningSafeAddress: undefined,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: true,
	activeRpcNetwork: {
		name: 'Test RPC',
		chainId: 1n,
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	},
})

const isNonEmptyArray = (value: unknown) => Array.isArray(value) && value.length > 0

// Runs hook once, right after the app stores an empty pending access request list, which is what closing the access dialog does.
function onPendingAccessRequestsCleared(browserMock: BackgroundBrowserMock, hook: () => void) {
	const localStorage = browserMock.browser.storage.local
	const writeLocalStorage = localStorage.set
	localStorage.set = async (items) => {
		await writeLocalStorage(items)
		const pendingRequests = readProperty(items, 'pendingInterceptorAccessRequests')
		if (!Array.isArray(pendingRequests) || pendingRequests.length !== 0) return
		localStorage.set = writeLocalStorage
		hook()
	}
}

// Runs hook once, while the app reads a non-empty pending access request list.
function onPendingAccessRequestsRead(browserMock: BackgroundBrowserMock, hook: () => void) {
	const localStorage = browserMock.browser.storage.local
	const readLocalStorage = localStorage.get
	localStorage.get = async (keys) => {
		const items = await readLocalStorage(keys)
		if (isNonEmptyArray(readProperty(items, 'pendingInterceptorAccessRequests'))) {
			localStorage.get = readLocalStorage
			hook()
		}
		return items
	}
}

// Closes the access dialog like the user closing its window or tab, and waits until the app's close listeners have finished so the test sees the completed cleanup.
async function closeAccessDialog(browserMock: BackgroundBrowserMock, dialog: PopupOrTabId) {
	const listenerRuns: unknown[] = []
	if (dialog.type === 'popup') {
		const onWindowRemoved = browserMock.browser.windows.onRemoved
		const dispatchWindowRemoved = onWindowRemoved.dispatch
		onWindowRemoved.dispatch = (...args) => {
			const results = dispatchWindowRemoved(...args)
			listenerRuns.push(...results)
			return results
		}
		try {
			await browserMock.browser.windows.remove(dialog.id)
		} finally {
			onWindowRemoved.dispatch = dispatchWindowRemoved
		}
	} else {
		const onTabRemoved = browserMock.browser.tabs.onRemoved
		const dispatchTabRemoved = onTabRemoved.dispatch
		onTabRemoved.dispatch = (...args) => {
			const results = dispatchTabRemoved(...args)
			listenerRuns.push(...results)
			return results
		}
		try {
			await browserMock.browser.tabs.remove(dialog.id)
		} finally {
			onTabRemoved.dispatch = dispatchTabRemoved
		}
	}
	if (listenerRuns.length === 0) throw new Error('Missing access dialog close listener')
	await Promise.all(listenerRuns)
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/windows/interceptorAccess.js'),
		...await import('../../app/ts/background/interceptorAccessResolution.js'),
		...await import('../../app/ts/background/background.js'),
	}
}

describe('interceptor access close handling', () => {
	test('does not emit pre-response connection events when eth_requestAccounts already has access', async () => {
		installBrowserMock()
		const { requestAccessFromUser, createInterceptedRequestReplay, websiteSocketToString, changeSimulationMode, updateWebsiteAccess, getSettings } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const account = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_requestAccounts',
		}
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		await requestAccessFromUser(websiteTabConnections, socket, website, request, undefined, await getSettings(), await getActiveAddressEntryForChain(account, 1n), createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, async () => undefined))

		const providerRequestMessages = messages
		assert.deepEqual(providerRequestMessages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
		assert.deepEqual(providerRequestMessages.map((message) => message.requestId), [7, 7])
		assert.deepEqual(providerRequestMessages[0]?.result, ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
		assert.deepEqual(providerRequestMessages[1]?.result, ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
	})

	test('serializes dialog close cleanup with matching request creation', async () => {
		const browserMock = installBrowserMock()
		const { requestAccessFromUser, getPendingAccessRequests, websiteSocketToString } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const settings = createSettings(undefined)

		await requestAccessFromUser(websiteTabConnections, socket, website, undefined, undefined, settings, undefined, undefined)
		const firstDialog = (await getPendingAccessRequests())[0]?.popupOrTabId
		if (firstDialog === undefined) throw new Error('Missing first access dialog')

		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}
		let replayCalls = 0
		let concurrentRequest: Promise<void> | undefined
		onPendingAccessRequestsCleared(browserMock, () => {
			concurrentRequest = requestAccessFromUser(
				websiteTabConnections,
				socket,
				website,
				request,
				undefined,
				settings,
				undefined,
				async () => {
					replayCalls += 1
				},
			)
		})

		await closeAccessDialog(browserMock, firstDialog)
		if (concurrentRequest === undefined) throw new Error('Concurrent access request was not started')
		await concurrentRequest

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(replayCalls, 0)
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_accounts')
		const secondDialog = pendingRequests[0]?.popupOrTabId
		if (secondDialog === undefined) throw new Error('Missing second access dialog')
		await closeAccessDialog(browserMock, secondDialog)
	})

	test('serializes dialog close cleanup with popup resolution', async () => {
		const browserMock = installBrowserMock()
		const { getPendingAccessRequests, requestAccessFromUser, resolveInterceptorAccess, websiteSocketToString } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const settings = createSettings(undefined)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await requestAccessFromUser(websiteTabConnections, socket, website, request, undefined, settings, undefined, async () => undefined)
		const dialog = (await getPendingAccessRequests())[0]?.popupOrTabId
		if (dialog === undefined) throw new Error('Missing access dialog')

		let dialogClosed: Promise<void> | undefined
		onPendingAccessRequestsRead(browserMock, () => {
			dialogClosed = closeAccessDialog(browserMock, dialog)
		})

		await resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{ originalRequestAccessToAddress: undefined, requestAccessToAddress: undefined, accessRequestId: 'undefined || https://example.test', userReply: 'Approved' },
			async () => undefined,
		)
		if (dialogClosed === undefined) throw new Error('Concurrent access dialog close was not started')
		await dialogClosed

		const ethAccountsReplies = messages.filter((message) => message.requestId !== undefined && message.method === 'eth_accounts')
		assert.equal(ethAccountsReplies.length, 1)
		assert.notEqual(ethAccountsReplies[0]?.error?.code, 4100)
	})

	test('prompts another connection after releasing the popup resolution semaphore', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingAccessRequests,
			requestAccessFromUser,
			resolveInterceptorAccess,
			websiteSocketToString,
		} = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const account = 0x1234567890123456789012345678901234567890n
		const firstWebsite = { websiteOrigin: 'https://first.example.test', icon: undefined, title: undefined }
		const secondWebsite = { websiteOrigin: 'https://second.example.test', icon: undefined, title: undefined }
		const firstSocket: WebsiteSocket = { tabId: 1, connectionName: 1n }
		const secondSocket: WebsiteSocket = { tabId: 2, connectionName: 2n }
		const websiteTabConnections: WebsiteTabConnections = new Map([
			[firstSocket.tabId, { connections: {
				[websiteSocketToString(firstSocket)]: {
					port: createPort(firstSocket.tabId).port,
					socket: firstSocket,
					websiteOrigin: firstWebsite.websiteOrigin,
					approved: false,
					wantsToConnect: true,
				},
			} }],
			[secondSocket.tabId, { connections: {
				[websiteSocketToString(secondSocket)]: {
					port: createPort(secondSocket.tabId).port,
					socket: secondSocket,
					websiteOrigin: secondWebsite.websiteOrigin,
					approved: false,
					wantsToConnect: true,
				},
			} }],
		])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const publishRpcConnectionStatus = async () => undefined
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		const activeAddress = await getActiveAddressEntryForChain(account, 1n)
		const settings = createSettings(account)

		await requestAccessFromUser(
			websiteTabConnections,
			firstSocket,
			firstWebsite,
			undefined,
			activeAddress,
			settings,
			activeAddress,
			undefined,
		)
		const firstRequest = (await getPendingAccessRequests())[0]
		if (firstRequest === undefined) throw new Error('Missing first access request')

		await settleWithin(resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: firstRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: firstRequest.originalRequestAccessToAddress?.address,
				accessRequestId: firstRequest.accessRequestId,
			},
			publishRpcConnectionStatus,
		), 250, 'Access approval did not resolve')

		const followUpRequest = (await getPendingAccessRequests()).find((request) => request.website.websiteOrigin === secondWebsite.websiteOrigin)
		if (followUpRequest === undefined) throw new Error('Missing follow-up access request')
		await resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Rejected',
				requestAccessToAddress: followUpRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: followUpRequest.originalRequestAccessToAddress?.address,
				accessRequestId: followUpRequest.accessRequestId,
			},
			publishRpcConnectionStatus,
		)
	})

	test('closes a tab-backed access dialog through its tab listener', async () => {
		const browserMock = installBrowserMock()
		const { getPendingAccessRequests, requestAccessFromUser, setUseTabsInsteadOfPopup, websiteSocketToString } = await loadModules()
		const website = { websiteOrigin: 'https://tab-dialog.example.test', icon: undefined, title: undefined }
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const settings = createSettings(undefined)
		await setUseTabsInsteadOfPopup(true)
		try {
			await requestAccessFromUser(websiteTabConnections, socket, website, undefined, undefined, settings, undefined, undefined)
			const pendingRequests = await getPendingAccessRequests()
			assert.equal(pendingRequests.length, 1)
			const dialog = pendingRequests[0]?.popupOrTabId
			assert.equal(dialog?.type, 'tab')
			if (dialog === undefined) throw new Error('Missing access dialog')
			await closeAccessDialog(browserMock, dialog)
			assert.deepEqual(await getPendingAccessRequests(), [])
		} finally {
			await setUseTabsInsteadOfPopup(false)
		}
	})
})

describe('interceptor access refused after the router asked for it', () => {
	const accessChanges: readonly { readonly name: string, readonly websiteAccess: Omit<WebsiteAccess, 'website'>, readonly expectedError: { readonly code: number, readonly message: string } }[] = [
		{
			name: 'denied',
			websiteAccess: { access: false, addressAccess: undefined },
			expectedError: { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'The requested method and/or account has not been authorized by the user.' },
		},
		{
			name: 'interceptor-disabled',
			websiteAccess: { interceptorDisabled: true, addressAccess: undefined },
			expectedError: ERROR_INTERCEPTOR_DISABLED.error,
		},
	]
	for (const { name, websiteAccess, expectedError } of accessChanges) {
		test(`replays a request whose website became ${ name } so the router refuses it without opening a dialog`, async () => {
			const browserMock = installBrowserMock()
			const { createInterceptedRequestReplay, getPendingAccessRequests, requestAccessFromUser, updateWebsiteAccess, websiteSocketToString } = await loadModules()
			const website = { websiteOrigin: 'https://refused-while-asking.example.test', icon: undefined, title: undefined }
			const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
			const { port, messages } = createPort(socket.tabId)
			const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
			} }]])
			// The router chose askAccess from settings without an entry for the website; the stored settings changed before the access dialog lock was taken.
			const settingsWhenRouterAsked = createSettings(undefined)
			await updateWebsiteAccess(() => [{ website, ...websiteAccess }])
			const request: InterceptedRequest = {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
				method: 'eth_requestAccounts',
			}
			const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

			await requestAccessFromUser(websiteTabConnections, socket, website, request, undefined, settingsWhenRouterAsked, undefined, createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, noopPublishRpcConnectionStatus))

			const replies = messages.filter((message) => message.requestId === request.uniqueRequestIdentifier.requestId)
			assert.deepEqual(replies.map((reply) => ({ method: reply.method, error: reply.error })), [{ method: 'eth_requestAccounts', error: expectedError }])
			assert.deepEqual(await getPendingAccessRequests(), [])
			assert.deepEqual(browserMock.calls.windowsCreate, [])
		})
	}
})
