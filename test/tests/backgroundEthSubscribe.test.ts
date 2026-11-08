import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { PASSTHROUGH_STATE } from '../../app/ts/types/visualizer-types.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../../app/ts/utils/constants.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, type PortMessage } from './backgroundEthAccountsTestHarness.js'

// `onPostMessage` runs after each post attempt is recorded in `messages`; throwing from it makes that post fail.
async function createApprovedSubscriberHarness({ onPostMessage }: { readonly onPostMessage?: (message: PortMessage) => void } = {}) {
	installBrowserMock()
	const modules = await loadModules()
	const { sendSubscriptionMessagesForNewBlock } = await import('../../app/ts/simulation/services/EthereumSubscriptionService.js')
	const websiteOrigin = 'https://subscriber.example'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	const account = 0x1111111111111111111111111111111111111111n
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	await modules.updateEthereumSubscriptionsAndFilters(() => [])

	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId, onPostMessage)
	const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const getBlockCalls = { count: 0 }
	const { ethereum, simulationServicesOwner } = createEthereumWithGetBlockCounter(getBlockCalls)
	const sendRequest = async (requestId: number, method: string, params: readonly unknown[]) => await modules.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId, requestSocket: socket },
		method,
		params: [...params],
	}, websiteTabConnections, noopPublishRpcConnectionStatus)
	const sendNewBlock = async () => await sendSubscriptionMessagesForNewBlock(8443561n, ethereum, true, websiteTabConnections, async () => PASSTHROUGH_STATE)
	return { modules, messages, getBlockCalls, sendRequest, sendNewBlock, socket, websiteTabConnections }
}

// Keep only the fields that identify each posted message so the assertions read as an ordered delivery log.
const summarizePortMessages = (messages: readonly object[]) => messages.map((message) => ({
	method: 'method' in message ? message.method : undefined,
	requestId: 'requestId' in message ? message.requestId : undefined,
	subscription: 'subscription' in message ? message.subscription : undefined,
	result: 'result' in message ? message.result : undefined,
}))

describe('background eth_subscribe', () => {
	test('syncing subscribers get the subscription id reply first, then exactly one false notification on the same port', async () => {
		const { modules, messages, sendRequest, sendNewBlock } = await createApprovedSubscriberHarness()

		await sendRequest(1, 'eth_subscribe', ['syncing'])
		const [subscription] = await modules.getEthereumSubscriptionsAndFilters()
		if (subscription?.type !== 'syncing') throw new Error('syncing subscription was not stored')
		const subscriptionId = subscription.subscriptionOrFilterId
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: subscriptionId },
			{ method: 'syncing', requestId: undefined, subscription: subscriptionId, result: { subscription: subscriptionId, result: false } },
		])

		await sendNewBlock()
		await sendNewBlock()
		assert.equal(messages.length, 2)

		await sendRequest(2, 'eth_unsubscribe', [subscriptionId])
		assert.deepEqual(summarizePortMessages(messages.slice(2)), [
			{ method: 'eth_unsubscribe', requestId: 2, subscription: undefined, result: true },
		])
		assert.deepEqual(await modules.getEthereumSubscriptionsAndFilters(), [])
	})

	test('newHeads subscribers only get the subscription id reply when subscribing', async () => {
		const { modules, messages, getBlockCalls, sendRequest } = await createApprovedSubscriberHarness()

		await sendRequest(1, 'eth_subscribe', ['newHeads'])
		const [subscription] = await modules.getEthereumSubscriptionsAndFilters()
		if (subscription?.type !== 'newHeads') throw new Error('newHeads subscription was not stored')
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: subscription.subscriptionOrFilterId },
		])
		assert.equal(getBlockCalls.count, 0)
	})

	test('the eth_subscribe handler returns a plain-data reply with its follow-up beside it and sends nothing itself', async () => {
		const { messages, socket, websiteTabConnections } = await createApprovedSubscriberHarness()
		const { subscribe } = await import('../../app/ts/background/simulationModeHandlers.js')

		const { reply, afterReplyDelivered } = await subscribe(websiteTabConnections, socket, { method: 'eth_subscribe', params: ['syncing'] })
		// structuredClone rejects functions the way postMessage does, so this fails if the reply ever carries a closure.
		assert.deepEqual(structuredClone(reply), reply)
		assert.deepEqual(messages, [])

		afterReplyDelivered()
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'syncing', requestId: undefined, subscription: reply.result, result: { subscription: reply.result, result: false } },
		])
	})

	test('syncing subscribers get no initial notification when the subscription id reply was not delivered', async () => {
		const { modules, messages, sendRequest } = await createApprovedSubscriberHarness({ onPostMessage: () => { throw new Error('Attempting to use a disconnected port object') } })

		await sendRequest(1, 'eth_subscribe', ['syncing'])
		const [subscription] = await modules.getEthereumSubscriptionsAndFilters()
		if (subscription?.type !== 'syncing') throw new Error('syncing subscription was not stored')
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: subscription.subscriptionOrFilterId },
		])
	})

	test('a failing initial notification is reported without sending a second reply to the answered eth_subscribe request', async () => {
		const notificationFailure = 'Could not serialize the syncing notification'
		const { modules, messages, sendRequest } = await createApprovedSubscriberHarness({ onPostMessage: (message) => { if (message.method === 'syncing') throw new Error(notificationFailure) } })
		assert.equal(await modules.getLatestUnexpectedError(), undefined)

		await sendRequest(1, 'eth_subscribe', ['syncing'])
		const [subscription] = await modules.getEthereumSubscriptionsAndFilters()
		if (subscription?.type !== 'syncing') throw new Error('syncing subscription was not stored')
		const subscriptionId = subscription.subscriptionOrFilterId
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: subscriptionId },
			{ method: 'syncing', requestId: undefined, subscription: subscriptionId, result: { subscription: subscriptionId, result: false } },
		])
		assert.equal((await modules.getLatestUnexpectedError())?.data.message, notificationFailure)
	})

	test('a rejecting async follow-up is reported without sending another reply', async () => {
		const { modules, messages, socket, websiteTabConnections } = await createApprovedSubscriberHarness()
		const { replyToInterceptedRequest } = await import('../../app/ts/background/messageSending.js')
		const followUpFailure = 'Async follow-up failed'
		assert.equal(await modules.getLatestUnexpectedError(), undefined)

		assert.equal(replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'eth_subscribe', result: '0x1', uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }), true)
		await modules.runAfterReplyDelivered(async () => {
			await Promise.resolve()
			throw new Error(followUpFailure)
		})
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: '0x1' },
		])
		assert.equal((await modules.getLatestUnexpectedError())?.data.message, followUpFailure)
	})

	test('unsupported subscription types get a single error reply', async () => {
		const { modules, messages, sendRequest } = await createApprovedSubscriberHarness()

		await sendRequest(1, 'eth_subscribe', ['logs'])
		assert.deepEqual(messages.map((message) => ({ method: message.method, requestId: message.requestId, errorCode: message.error?.code })), [
			{ method: 'eth_subscribe', requestId: 1, errorCode: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER },
		])
		assert.deepEqual(await modules.getEthereumSubscriptionsAndFilters(), [])
	})
})
