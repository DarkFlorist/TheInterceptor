import type { EthNewFilter, EthSubscribeParams } from '../../types/JsonRpc-types.js'
import { assertNever } from '../../utils/typescript.js'
import type { EthereumClientService } from './EthereumClientService.js'
import { getEthereumSubscriptionsAndFilters, updateEthereumSubscriptionsAndFilters } from '../../background/storageVariables.js'
import type { EthereumSubscriptionsAndFilters, ResolvedExecutionSimulationState, ResolvedSimulationInput } from '../../types/visualizer-types.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getSimulatedBlockFromInput, getSimulatedBlockNumber, getSimulatedBlockNumberFromInput, getSimulatedLogs } from './SimulationModeEthereumClientService.js'
import { sendSubscriptionReplyOrCallBack } from '../../background/messageSending.js'
import type { WebsiteSocket } from '../../utils/requests.js'

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
			const sameSocket = subscription.subscriptionCreatorSocket.tabId === socket.tabId && subscription.subscriptionCreatorSocket.connectionName === socket.connectionName
			return !(sameSubscription && sameSocket) // only allow the same tab and connection to remove the subscription
		})
	})
	if (
		changes.oldSubscriptions.find((sub) => sub.subscriptionOrFilterId === subscriptionOrFilterId && sub.subscriptionCreatorSocket.tabId === socket.tabId && sub.subscriptionCreatorSocket.connectionName === socket.connectionName) !== undefined &&
		changes.newSubscriptions.find((sub) => sub.subscriptionOrFilterId === subscriptionOrFilterId && sub.subscriptionCreatorSocket.tabId === socket.tabId && sub.subscriptionCreatorSocket.connectionName === socket.connectionName) === undefined
	) {
		return true // subscription was found and removed
	}
	return false
}

export async function sendSubscriptionMessagesForNewBlock(blockNumber: bigint, ethereumClientService: EthereumClientService, isSimulation: boolean, websiteTabConnections: WebsiteTabConnections, getSimulationState: (ethereumClientService: EthereumClientService) => Promise<ResolvedExecutionSimulationState>) {
	const ethereumSubscriptionsAndFilters = await getEthereumSubscriptionsAndFilters()
	let liveBlockPromise: Promise<Awaited<ReturnType<EthereumClientService['getBlock']>>> | undefined
	let simulationStatePromise: Promise<ResolvedExecutionSimulationState> | undefined
	let simulatedBlocksPromise: Promise<readonly NonNullable<Awaited<ReturnType<typeof getSimulatedBlockFromInput>>>[]> | undefined
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
			const simulationInput = {
				kind: 'simulated' as const,
				value: simulationState.value.simulationStateInput,
			}
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
	for (const subscriptionOrFilter of ethereumSubscriptionsAndFilters) {
		if (websiteTabConnections.get(subscriptionOrFilter.subscriptionCreatorSocket.tabId) === undefined) {
			// connection removed
			await removeEthereumSubscription(subscriptionOrFilter.subscriptionCreatorSocket, subscriptionOrFilter.subscriptionOrFilterId)
			continue
		}
		switch (subscriptionOrFilter.type) {
			case 'newHeads': {
				const newBlock = await getLiveBlock()

				sendSubscriptionReplyOrCallBack(websiteTabConnections, subscriptionOrFilter.subscriptionCreatorSocket, {
					type: 'result',
					method: 'newHeads' as const,
					result: {
						subscription: subscriptionOrFilter.type,
						result: newBlock,
					} as const,
					subscription: subscriptionOrFilter.subscriptionOrFilterId,
				})

				if (isSimulation) {
					for (const simulatedBlock of await getSimulatedBlocks()) {
						// post our simulated blocks on top (reorg them)
						sendSubscriptionReplyOrCallBack(websiteTabConnections, subscriptionOrFilter.subscriptionCreatorSocket, {
							type: 'result',
							method: 'newHeads' as const,
							result: {
								subscription: subscriptionOrFilter.type,
								result: simulatedBlock,
							},
							subscription: subscriptionOrFilter.subscriptionOrFilterId,
						})
					}
				}
				break
			}
			case 'eth_newFilter':
				break
			default:
				assertNever(subscriptionOrFilter)
		}
	}
	return
}
export async function createEthereumSubscription(params: EthSubscribeParams, subscriptionCreatorSocket: WebsiteSocket) {
	switch (params.params[0]) {
		case 'newHeads': {
			const subscriptionOrFilterId = generateId(40)
			await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
				return subscriptionsAndfilters.concat({
					type: 'newHeads',
					subscriptionOrFilterId,
					params,
					subscriptionCreatorSocket,
				})
			})
			return subscriptionOrFilterId
		}
		case 'logs':
			throw `Dapp requested for 'logs' subscription but it's not implemented` //TODO: implement
		case 'newPendingTransactions':
			throw `Dapp requested for 'newPendingTransactions' subscription but it's not implemented` //TODO: implement
		case 'syncing':
			throw `Dapp requested for 'syncing' subscription but it's not implemented` //TODO: implement
	}
}

export async function createNewFilter(params: EthNewFilter, subscriptionCreatorSocket: WebsiteSocket, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationInput: ResolvedSimulationInput) {
	const calledInlastBlock = await getSimulatedBlockNumberFromInput(ethereumClientService, requestAbortController, simulationInput)
	const subscriptionOrFilterId = generateId(40)
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
		return subscriptionsAndfilters.concat({
			type: 'eth_newFilter',
			subscriptionOrFilterId,
			params,
			subscriptionCreatorSocket,
			calledInlastBlock,
		})
	})
	return subscriptionOrFilterId
}

export async function getEthFilterChanges(filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState) {
	const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
	const filter = filtersAndSubscriptions.find((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId)
	if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
	if (filter.params.params[0].blockhash !== undefined) throw new Error('blockhash not supported for this method')
	const calledInlastBlock = await getSimulatedBlockNumber(ethereumClientService, requestAbortController, simulationState)
	const logs =
		calledInlastBlock > filter.calledInlastBlock
			? await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, {
					...filter.params.params[0],
					fromBlock: filter.calledInlastBlock + 1n,
					toBlock: calledInlastBlock,
				})
			: []
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters) => {
		return subscriptionsAndfilters.map((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId ? { ...subscriptionOrfilter, calledInlastBlock } : subscriptionOrfilter)
	})
	return logs
}

export async function getEthFilterLogs(filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState) {
	const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
	const filter = filtersAndSubscriptions.find((filter) => filter.subscriptionOrFilterId === filterId)
	if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
	if (filter.params.params[0].blockhash !== undefined) throw new Error('blockhash not supported for this method')
	return await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, filter.params.params[0])
}
