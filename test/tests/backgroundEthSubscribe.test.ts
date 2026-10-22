import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { PASSTHROUGH_STATE } from '../../app/ts/types/visualizer-types.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../../app/ts/utils/constants.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

// With `portDisconnected`, every post attempt is still recorded in `messages` but fails the way a closed port does, so no reply is delivered.
async function createApprovedSubscriberHarness({ portDisconnected = false }: { readonly portDisconnected?: boolean } = {}) {
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
	const { port, messages } = createPort(socket.tabId, portDisconnected ? () => { throw new Error('Attempting to use a disconnected port object') } : undefined)
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
	return { modules, messages, getBlockCalls, sendRequest, sendNewBlock }
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

	test('syncing subscribers get no initial notification when the subscription id reply was not delivered', async () => {
		const { modules, messages, sendRequest } = await createApprovedSubscriberHarness({ portDisconnected: true })

		await sendRequest(1, 'eth_subscribe', ['syncing'])
		const [subscription] = await modules.getEthereumSubscriptionsAndFilters()
		if (subscription?.type !== 'syncing') throw new Error('syncing subscription was not stored')
		assert.deepEqual(summarizePortMessages(messages), [
			{ method: 'eth_subscribe', requestId: 1, subscription: undefined, result: subscription.subscriptionOrFilterId },
		])
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
