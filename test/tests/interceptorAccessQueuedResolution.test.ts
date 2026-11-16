import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PendingAccessRequest } from '../../app/ts/types/accessRequest.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { InterceptedRequest, WebsiteSocket } from '../../app/ts/utils/requests.js'
import { METAMASK_ERROR_NOT_AUTHORIZED } from '../../app/ts/utils/constants.js'
import { addressString, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const ACTIVE_ACCOUNT = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const REQUESTING_WEBSITE = { websiteOrigin: 'https://requesting.example.test', icon: undefined, title: undefined }
const QUEUED_WEBSITE = { websiteOrigin: 'https://queued.example.test', icon: undefined, title: undefined }
const REQUESTING_SOCKET: WebsiteSocket = { tabId: 1, connectionName: 1n }
const QUEUED_SOCKET: WebsiteSocket = { tabId: 2, connectionName: 2n }
const REQUESTING_REQUEST_ID = 11
const QUEUED_REQUEST_ID = 22

const createRequest = (socket: WebsiteSocket, requestId: number, method: string): InterceptedRequest => ({
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId, requestSocket: socket },
	method,
})

async function setupTwoWebsites() {
	const browserMock = installBrowserMock()
	const modules = await loadModules()
	const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: ACTIVE_ACCOUNT })
	const requestingPort = createPort(REQUESTING_SOCKET.tabId, undefined, undefined, REQUESTING_SOCKET.connectionName)
	const queuedPort = createPort(QUEUED_SOCKET.tabId, undefined, undefined, QUEUED_SOCKET.connectionName)
	const websiteTabConnections = new Map([
		[REQUESTING_SOCKET.tabId, { connections: {
			[modules.websiteSocketToString(REQUESTING_SOCKET)]: { port: requestingPort.port, socket: REQUESTING_SOCKET, websiteOrigin: REQUESTING_WEBSITE.websiteOrigin, approved: false, wantsToConnect: true },
		} }],
		[QUEUED_SOCKET.tabId, { connections: {
			[modules.websiteSocketToString(QUEUED_SOCKET)]: { port: queuedPort.port, socket: QUEUED_SOCKET, websiteOrigin: QUEUED_WEBSITE.websiteOrigin, approved: false, wantsToConnect: true },
		} }],
	])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const activeAddress = await getActiveAddressEntryForChain(ACTIVE_ACCOUNT, 1n)

	// Calls the access gate directly so that methods the background answers without a dialog can sit in the queue too.
	const addToAccessQueue = async (website: Website, socket: WebsiteSocket, request: InterceptedRequest) => {
		await modules.requestAccessFromUser(simulationServicesOwner, websiteTabConnections, socket, website, request, activeAddress, await modules.getSettings(), activeAddress, noopPublishRpcConnectionStatus)
	}
	const sendFromWebsite = async (website: Website, socket: WebsiteSocket, port: browser.runtime.Port, request: InterceptedRequest) => {
		await modules.handleInterceptedRequest(port, website.websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
	}
	const answerAccessRequest = async (website: Website, userReply: 'Approved' | 'Rejected') => {
		const pendingRequest = (await modules.getPendingAccessRequests()).find((pending) => pending.website.websiteOrigin === website.websiteOrigin)
		if (pendingRequest === undefined) throw new Error(`Missing access request for ${ website.websiteOrigin }`)
		await modules.resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply,
			requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)
	}
	const getQueuedOrigins = async () => (await modules.getPendingAccessRequests()).map((pending) => pending.website.websiteOrigin)
	const getLastDialogOrigins = () => {
		const dialogUpdates = browserMock.runtimeMessages.flatMap((message): readonly (readonly PendingAccessRequest[])[] => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_interceptorAccessDialog' ? [parsed.value.data.pendingAccessRequests] : []
		})
		return dialogUpdates.at(-1)?.map((pending) => pending.website.websiteOrigin)
	}
	return { addToAccessQueue, answerAccessRequest, browserMock, getLastDialogOrigins, getQueuedOrigins, queuedPort, requestingPort, sendFromWebsite }
}

function getWebsiteReplies(messages: ReturnType<typeof createPort>['messages'], requestId: number) {
	return messages
		.filter((message) => message.requestId === requestId && message.method !== 'accountsChanged')
		.map((message) => message.error === undefined ? { result: message.result } : { errorCode: message.error.code })
}

describe('resolving an access request while another request stays queued', () => {
	// Test files share the background module, so opening the first dialog can close one left open by an earlier file. Only dialog closes after the requests are queued count.
	test('answers a rejected website and keeps showing the next queued website', async () => {
		const { answerAccessRequest, browserMock, getLastDialogOrigins, getQueuedOrigins, queuedPort, requestingPort, sendFromWebsite } = await setupTwoWebsites()
		await sendFromWebsite(REQUESTING_WEBSITE, REQUESTING_SOCKET, requestingPort.port, createRequest(REQUESTING_SOCKET, REQUESTING_REQUEST_ID, 'eth_requestAccounts'))
		await sendFromWebsite(QUEUED_WEBSITE, QUEUED_SOCKET, queuedPort.port, createRequest(QUEUED_SOCKET, QUEUED_REQUEST_ID, 'eth_requestAccounts'))
		const closedDialogsBeforeAnswering = browserMock.removedWindowIds.length

		await answerAccessRequest(REQUESTING_WEBSITE, 'Rejected')

		assert.deepEqual(getWebsiteReplies(requestingPort.messages, REQUESTING_REQUEST_ID), [{ errorCode: METAMASK_ERROR_NOT_AUTHORIZED }])
		assert.deepEqual(await getQueuedOrigins(), [QUEUED_WEBSITE.websiteOrigin])
		assert.deepEqual(getLastDialogOrigins(), [QUEUED_WEBSITE.websiteOrigin])
		assert.equal(browserMock.removedWindowIds.length, closedDialogsBeforeAnswering)
		assert.deepEqual(getWebsiteReplies(queuedPort.messages, QUEUED_REQUEST_ID), [])

		await answerAccessRequest(QUEUED_WEBSITE, 'Rejected')

		assert.deepEqual(getWebsiteReplies(queuedPort.messages, QUEUED_REQUEST_ID), [{ errorCode: METAMASK_ERROR_NOT_AUTHORIZED }])
		assert.deepEqual(await getQueuedOrigins(), [])
		assert.equal(browserMock.removedWindowIds.length, closedDialogsBeforeAnswering + 1)
	})

	test('replays an approved website and keeps showing the next queued website', async () => {
		const { answerAccessRequest, browserMock, getLastDialogOrigins, getQueuedOrigins, queuedPort, requestingPort, sendFromWebsite } = await setupTwoWebsites()
		await sendFromWebsite(REQUESTING_WEBSITE, REQUESTING_SOCKET, requestingPort.port, createRequest(REQUESTING_SOCKET, REQUESTING_REQUEST_ID, 'eth_requestAccounts'))
		await sendFromWebsite(QUEUED_WEBSITE, QUEUED_SOCKET, queuedPort.port, createRequest(QUEUED_SOCKET, QUEUED_REQUEST_ID, 'eth_requestAccounts'))
		const closedDialogsBeforeAnswering = browserMock.removedWindowIds.length

		await answerAccessRequest(REQUESTING_WEBSITE, 'Approved')

		assert.deepEqual(getWebsiteReplies(requestingPort.messages, REQUESTING_REQUEST_ID), [{ result: [addressString(ACTIVE_ACCOUNT)] }])
		assert.deepEqual(await getQueuedOrigins(), [QUEUED_WEBSITE.websiteOrigin])
		assert.deepEqual(getLastDialogOrigins(), [QUEUED_WEBSITE.websiteOrigin])
		assert.equal(browserMock.removedWindowIds.length, closedDialogsBeforeAnswering)
		assert.deepEqual(getWebsiteReplies(queuedPort.messages, QUEUED_REQUEST_ID), [])

		await answerAccessRequest(QUEUED_WEBSITE, 'Rejected')

		assert.deepEqual(await getQueuedOrigins(), [])
		assert.equal(browserMock.removedWindowIds.length, closedDialogsBeforeAnswering + 1)
	})

	const expectedRejectionReplies = [
		{ method: 'eth_accounts', reply: { result: [] } },
		{ method: 'wallet_getPermissions', reply: { result: [] } },
		{ method: 'eth_chainId', reply: { result: '0x1' } },
		{ method: 'net_version', reply: { result: '1' } },
		{ method: 'eth_requestAccounts', reply: { errorCode: METAMASK_ERROR_NOT_AUTHORIZED } },
		{ method: 'wallet_requestPermissions', reply: { errorCode: METAMASK_ERROR_NOT_AUTHORIZED } },
		{ method: 'eth_call', reply: { errorCode: METAMASK_ERROR_NOT_AUTHORIZED } },
	]

	for (const { method, reply } of expectedRejectionReplies) {
		test(`gives a rejected ${ method } the same reply whether or not it is last in the queue`, async () => {
			const { addToAccessQueue, answerAccessRequest, getQueuedOrigins, queuedPort, requestingPort } = await setupTwoWebsites()
			await addToAccessQueue(REQUESTING_WEBSITE, REQUESTING_SOCKET, createRequest(REQUESTING_SOCKET, REQUESTING_REQUEST_ID, method))
			await addToAccessQueue(QUEUED_WEBSITE, QUEUED_SOCKET, createRequest(QUEUED_SOCKET, QUEUED_REQUEST_ID, method))

			await answerAccessRequest(REQUESTING_WEBSITE, 'Rejected')
			assert.deepEqual(getWebsiteReplies(requestingPort.messages, REQUESTING_REQUEST_ID), [reply])
			assert.deepEqual(await getQueuedOrigins(), [QUEUED_WEBSITE.websiteOrigin])

			await answerAccessRequest(QUEUED_WEBSITE, 'Rejected')
			assert.deepEqual(getWebsiteReplies(queuedPort.messages, QUEUED_REQUEST_ID), [reply])
			assert.deepEqual(await getQueuedOrigins(), [])
		})
	}
})
