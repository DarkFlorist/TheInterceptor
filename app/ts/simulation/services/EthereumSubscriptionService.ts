import type { EthNewFilter, EthSubscribeParams } from '../../types/JsonRpc-types.js'
import { hasOwnKey } from '../../utils/typescript.js'
import type { EthereumClientService } from './EthereumClientService.js'
import { getEthereumSubscriptionsAndFilters, updateEthereumSubscriptionsAndFilters } from '../../background/storageVariables.js'
import type { EthereumSubscriptionsAndFilters, ResolvedExecutionSimulationState, ResolvedSimulationInput } from '../../types/visualizer-types.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getSimulatedBlockFromInput, getSimulatedBlockNumber, getSimulatedBlockNumberFromInput, getSimulatedLogs } from './SimulationModeEthereumClientService.js'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBack } from '../../background/messageSending.js'
import type { UniqueRequestIdentifier, WebsiteSocket } from '../../utils/requests.js'
import { websiteSocketToString } from '../../background/backgroundUtils.js'
import { createScopedKeyedSerialExecutor } from '../../utils/semaphore.js'
import { JsonRpcResponseError } from '../../utils/errors.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../../utils/constants.js'

const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

function generateId(len: number) {
	const arr = new Uint8Array((len || 40) / 2)
	globalThis.crypto.getRandomValues(arr)
	return `0x${ Array.from(arr, dec2hex).join('') }`
}

export async function removeEthereumSubscription(socket: WebsiteSocket, subscriptionOrFilterId: string) {
	const changes = await updateEthereumSubscriptionsAndFilters((subscriptions: EthereumSubscriptionsAndFilters) => {
		return subscriptions.filter((subscription) => {
			const sameSubscription = subscription.subscriptionOrFilterId === subscriptionOrFilterId
			const sameSocket = subscription.subscriptionCreatorSocket.tabId === socket.tabId
				&& subscription.subscriptionCreatorSocket.connectionName === socket.connectionName
			return !(sameSubscription && sameSocket) // only allow the same tab and connection to remove the subscription
		})
	})
	if (changes.oldSubscriptions.find((sub) =>
		sub.subscriptionOrFilterId === subscriptionOrFilterId
		&& sub.subscriptionCreatorSocket.tabId === socket.tabId
		&& sub.subscriptionCreatorSocket.connectionName === socket.connectionName
	) !== undefined
		&& changes.newSubscriptions.find((sub) =>
			sub.subscriptionOrFilterId === subscriptionOrFilterId
			&& sub.subscriptionCreatorSocket.tabId === socket.tabId
			&& sub.subscriptionCreatorSocket.connectionName === socket.connectionName
		) === undefined
	) {
		return true // subscription was found and removed
	}
	return false
}

const isSameWebsiteSocket = (left: WebsiteSocket, right: WebsiteSocket) => left.tabId === right.tabId && left.connectionName === right.connectionName
const filterChangesScope = {}
const runFilterChangeSerially = createScopedKeyedSerialExecutor<typeof filterChangesScope, string>()

type StoredEthSubscription = Exclude<EthereumSubscriptionsAndFilters[number], { readonly type: 'eth_newFilter' }>
type LiveBlock = Awaited<ReturnType<EthereumClientService['getBlock']>>
type SimulatedBlock = NonNullable<Awaited<ReturnType<typeof getSimulatedBlockFromInput>>>
// Each is fetched at most once per block, however many subscribers need it.
type NewBlockSources = {
	readonly isSimulation: boolean
	readonly getLiveBlock: () => Promise<LiveBlock>
	readonly getSimulatedBlocks: () => Promise<readonly SimulatedBlock[]>
}
type EthSubscriptionTypeBehaviour = {
	// Sent once, right after the subscriber received the eth_subscribe reply carrying the subscription id.
	readonly sendInitialMessages: (websiteTabConnections: WebsiteTabConnections, subscription: StoredEthSubscription) => void
	readonly sendNewBlockMessages: (websiteTabConnections: WebsiteTabConnections, subscription: StoredEthSubscription, newBlockSources: NewBlockSources) => Promise<void>
}

// Everything that differs between the supported eth_subscribe types; createEthereumSubscription rejects types without an entry. Supporting a type takes an entry here, its stored record runtype in EthereumSubscriptionsAndFilters and its notification payload in SubscriptionReturnValue; the Record type makes a stored type without an entry a type error.
const ethSubscriptionTypes: Record<StoredEthSubscription['type'], EthSubscriptionTypeBehaviour> = {
	newHeads: {
		// newHeads subscribers are only notified about blocks that arrive after they subscribed.
		sendInitialMessages: () => undefined,
		sendNewBlockMessages: async (websiteTabConnections, subscription, newBlockSources) => {
			const newBlock = await newBlockSources.getLiveBlock()
			sendSubscriptionReplyOrCallBack(websiteTabConnections, subscription.subscriptionCreatorSocket, {
				type: 'result',
				method: 'newHeads' as const,
				result: { subscription: subscription.subscriptionOrFilterId, result: newBlock } as const,
				subscription: subscription.subscriptionOrFilterId,
			})
			if (!newBlockSources.isSimulation) return
			for (const simulatedBlock of await newBlockSources.getSimulatedBlocks()) {
				// post our simulated blocks on top (reorg them)
				sendSubscriptionReplyOrCallBack(websiteTabConnections, subscription.subscriptionCreatorSocket, {
					type: 'result',
					method: 'newHeads' as const,
					result: { subscription: subscription.subscriptionOrFilterId, result: simulatedBlock },
					subscription: subscription.subscriptionOrFilterId,
				})
			}
		},
	},
	syncing: {
		// geth immediately sends a new subscriber its current sync status. The Interceptor treats its RPC node as always synced, so that status is `false`, and new blocks cannot change it.
		sendInitialMessages: (websiteTabConnections, subscription) => {
			sendSubscriptionReplyOrCallBack(websiteTabConnections, subscription.subscriptionCreatorSocket, {
				type: 'result',
				method: 'syncing',
				result: { subscription: subscription.subscriptionOrFilterId, result: false },
				subscription: subscription.subscriptionOrFilterId,
			})
		},
		sendNewBlockMessages: async () => undefined,
	},
}

export async function sendSubscriptionMessagesForNewBlock(
	blockNumber: bigint,
	ethereumClientService: EthereumClientService,
	isSimulation: boolean,
	websiteTabConnections: WebsiteTabConnections,
	getSimulationState: (ethereumClientService: EthereumClientService) => Promise<ResolvedExecutionSimulationState>,
) {
	const ethereumSubscriptionsAndFilters = await getEthereumSubscriptionsAndFilters()
	let liveBlockPromise: Promise<LiveBlock> | undefined
	let simulationStatePromise: Promise<ResolvedExecutionSimulationState> | undefined
	let simulatedBlocksPromise: Promise<readonly SimulatedBlock[]> | undefined
	const getLiveBlock = async () => {
		if (liveBlockPromise === undefined) liveBlockPromise = ethereumClientService.getBlock(undefined, blockNumber, false)
		return await liveBlockPromise
	}
	const getCachedSimulationState = async () => {
		if (simulationStatePromise === undefined) simulationStatePromise = getSimulationState(ethereumClientService)
		return await simulationStatePromise
	}
	const getSimulatedBlocks = async () => {
		if (simulatedBlocksPromise !== undefined) return await simulatedBlocksPromise
		simulatedBlocksPromise = (async () => {
			const simulationState = await getCachedSimulationState()
			if (simulationState.kind === 'passthrough' || simulationState.value.success !== true) return []
			const simulationInput = { kind: 'simulated' as const, value: simulationState.value.simulationStateInput }
			const simulatedHead = await getSimulatedBlockNumberFromInput(ethereumClientService, undefined, simulationInput)
			const simulatedBlocks = []
			for (let simulatedBlockNumber = blockNumber + 1n; simulatedBlockNumber <= simulatedHead; simulatedBlockNumber++) {
				const simulatedBlock = await getSimulatedBlockFromInput(ethereumClientService, undefined, simulationInput, simulatedBlockNumber, false)
				if (simulatedBlock !== null) simulatedBlocks.push(simulatedBlock)
			}
			return simulatedBlocks
		})()
		return await simulatedBlocksPromise
	}
	const newBlockSources = { isSimulation, getLiveBlock, getSimulatedBlocks }
	for (const subscriptionOrFilter of ethereumSubscriptionsAndFilters) {
		const tabConnection = websiteTabConnections.get(subscriptionOrFilter.subscriptionCreatorSocket.tabId)
		if (tabConnection?.connections[websiteSocketToString(subscriptionOrFilter.subscriptionCreatorSocket)] === undefined) { // connection removed
			await removeEthereumSubscription(subscriptionOrFilter.subscriptionCreatorSocket, subscriptionOrFilter.subscriptionOrFilterId)
			continue
		}
		if (subscriptionOrFilter.type === 'eth_newFilter') continue // filters are polled through eth_getFilterChanges instead
		await ethSubscriptionTypes[subscriptionOrFilter.type].sendNewBlockMessages(websiteTabConnections, subscriptionOrFilter, newBlockSources)
	}
	return
}

async function createEthereumSubscription(params: EthSubscribeParams, subscriptionCreatorSocket: WebsiteSocket) {
	const type = params.params[0]
	if (!hasOwnKey(ethSubscriptionTypes, type)) {
		throw new JsonRpcResponseError({
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
				message: `Dapp requested for '${ type }' subscription but it's not implemented`,
			},
		})
	}
	const subscription: StoredEthSubscription = { type, subscriptionOrFilterId: generateId(40), params, subscriptionCreatorSocket }
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
		return subscriptionsAndfilters.concat(subscription)
	})
	return subscription
}

// The only way to create an eth_subscribe subscription, so no caller can send a subscription id without the initial messages that must follow it. Both travel on the same port in this order, so the page already knows the id when a notification for it arrives.
export async function createEthereumSubscriptionAndReply(websiteTabConnections: WebsiteTabConnections, params: EthSubscribeParams, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	const subscription = await createEthereumSubscription(params, uniqueRequestIdentifier.requestSocket)
	const replyDelivered = replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: params.method, result: subscription.subscriptionOrFilterId, uniqueRequestIdentifier })
	if (replyDelivered === true) ethSubscriptionTypes[subscription.type].sendInitialMessages(websiteTabConnections, subscription)
	return subscription.subscriptionOrFilterId
}

export async function createNewFilter(params: EthNewFilter, subscriptionCreatorSocket: WebsiteSocket, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationInput: ResolvedSimulationInput) {
	const calledInlastBlock = await getSimulatedBlockNumberFromInput(ethereumClientService, requestAbortController, simulationInput)
	const subscriptionOrFilterId = generateId(40)
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
		return subscriptionsAndfilters.concat({ type: 'eth_newFilter', subscriptionOrFilterId, params, subscriptionCreatorSocket, calledInlastBlock })
	})
	return subscriptionOrFilterId
}

export async function getEthFilterChanges(socket: WebsiteSocket, filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState) {
	return await runFilterChangeSerially(filterChangesScope, `${ websiteSocketToString(socket) }:${ filterId }`, async () => {
		const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
		const filter = filtersAndSubscriptions.find((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId && isSameWebsiteSocket(subscriptionOrfilter.subscriptionCreatorSocket, socket))
		if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
		if (filter.params.params[0].blockHash !== undefined) throw new Error('blockHash not supported for this method')
		const calledInlastBlock = await getSimulatedBlockNumber(ethereumClientService, requestAbortController, simulationState)
		const logs = calledInlastBlock > filter.calledInlastBlock
			? await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, { ...filter.params.params[0], fromBlock: filter.calledInlastBlock + 1n, toBlock: calledInlastBlock })
			: []
		await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters) => {
			return subscriptionsAndfilters.map((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId
				&& isSameWebsiteSocket(subscriptionOrfilter.subscriptionCreatorSocket, socket)
				&& subscriptionOrfilter.type === 'eth_newFilter'
				&& calledInlastBlock > subscriptionOrfilter.calledInlastBlock
				? { ...subscriptionOrfilter, calledInlastBlock }
				: subscriptionOrfilter)
		})
		return logs
	})
}

export async function getEthFilterLogs(socket: WebsiteSocket, filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState) {
	const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
	const filter = filtersAndSubscriptions.find((filter) => filter.subscriptionOrFilterId === filterId && isSameWebsiteSocket(filter.subscriptionCreatorSocket, socket))
	if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
	if (filter.params.params[0].blockHash !== undefined) throw new Error('blockHash not supported for this method')
	return await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, filter.params.params[0])
}
