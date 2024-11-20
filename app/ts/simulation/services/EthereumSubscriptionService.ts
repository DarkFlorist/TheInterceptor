import { EthNewFilter, EthSubscribeParams } from '../../types/JsonRpc-types.js'
import { assertNever } from '../../utils/typescript.js'
import { EthereumClientService } from './EthereumClientService.js'
import { getEthereumSubscriptionsAndFilters, updateEthereumSubscriptionsAndFilters } from '../../background/storageVariables.js'
import { EthereumSubscriptionsAndFilters, SimulationState } from '../../types/visualizer-types.js'
import { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getSimulatedBlock, getSimulatedLogs } from './SimulationModeEthereumClientService.js'
import { sendSubscriptionReplyOrCallBack } from '../../background/messageSending.js'
import { WebsiteSocket } from '../../utils/requests.js'

const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

function generateId(len: number) {
	const arr = new Uint8Array((len || 40) / 2)
	globalThis.crypto.getRandomValues(arr)
	return `0x${ Array.from(arr, dec2hex).join('') }`
}

export async function removeEthereumSubscription(socket: WebsiteSocket, subscriptionOrFilterId: string) {
	const changes = await updateEthereumSubscriptionsAndFilters((subscriptions: EthereumSubscriptionsAndFilters) => {
		return subscriptions.filter((subscription) => subscription.subscriptionOrFilterId !== subscriptionOrFilterId
			&& subscription.subscriptionCreatorSocket.tabId === socket.tabId // only allow the same tab and connection to remove the subscription
			&& subscription.subscriptionCreatorSocket.connectionName === socket.connectionName
		)
	})
	if (changes.oldSubscriptions.find((sub) => sub.subscriptionOrFilterId === subscriptionOrFilterId) !== undefined
		&& changes.newSubscriptions.find((sub) => sub.subscriptionOrFilterId === subscriptionOrFilterId) === undefined
	) {
		return true // subscription was found and removed
	}
	return false
}

export async function sendSubscriptionMessagesForNewBlock(blockNumber: bigint, ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, websiteTabConnections: WebsiteTabConnections) {
	const ethereumSubscriptionsAndFilters = await getEthereumSubscriptionsAndFilters()
	for (const subscriptionOrFilter of ethereumSubscriptionsAndFilters) {
		if (websiteTabConnections.get(subscriptionOrFilter.subscriptionCreatorSocket.tabId) === undefined) { // connection removed
			await removeEthereumSubscription(subscriptionOrFilter.subscriptionCreatorSocket, subscriptionOrFilter.subscriptionOrFilterId)
			break
		}
		switch (subscriptionOrFilter.type) {
			case 'newHeads': {
				const newBlock = await ethereumClientService.getBlock(undefined, blockNumber, false)

				sendSubscriptionReplyOrCallBack(websiteTabConnections, subscriptionOrFilter.subscriptionCreatorSocket, {
					type: 'result',
					method: 'newHeads' as const,
					result: { subscription: subscriptionOrFilter.type, result: newBlock } as const,
					subscription: subscriptionOrFilter.subscriptionOrFilterId,
				})

				if (simulationState !== undefined) {
					const simulatedBlock = await getSimulatedBlock(ethereumClientService, undefined, simulationState, blockNumber + 1n, false)
					// post our simulated block on top (reorg it)
					sendSubscriptionReplyOrCallBack(websiteTabConnections, subscriptionOrFilter.subscriptionCreatorSocket, {
						type: 'result',
						method: 'newHeads' as const,
						result: { subscription: subscriptionOrFilter.type, result: simulatedBlock },
						subscription: subscriptionOrFilter.subscriptionOrFilterId,
					})
				}
				break
			}
			case 'eth_newFilter': break
			default: assertNever(subscriptionOrFilter)
		}
	}
	return
}
export async function createEthereumSubscription(params: EthSubscribeParams, subscriptionCreatorSocket: WebsiteSocket) {
	switch(params.params[0]) {
		case 'newHeads': {
			const subscriptionOrFilterId = generateId(40)
			await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
				return subscriptionsAndfilters.concat({ type: 'newHeads', subscriptionOrFilterId, params, subscriptionCreatorSocket })
			})
			return subscriptionOrFilterId
		}
		case 'logs': throw 'Dapp requested for \'logs\' subscription but it\'s not implemented' //TODO: implement
		case 'newPendingTransactions': throw 'Dapp requested for \'newPendingTransactions\' subscription but it\'s not implemented' //TODO: implement
		case 'syncing': throw 'Dapp requested for \'syncing\' subscription but it\'s not implemented' //TODO: implement
	}
}

export async function createNewFilter(params: EthNewFilter, subscriptionCreatorSocket: WebsiteSocket, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) {
	const calledInlastBlock = simulationState?.blockNumber || await ethereumClientService.getBlockNumber(requestAbortController)
	const subscriptionOrFilterId = generateId(40)
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters: EthereumSubscriptionsAndFilters) => {
		return subscriptionsAndfilters.concat({ type: 'eth_newFilter', subscriptionOrFilterId, params, subscriptionCreatorSocket, calledInlastBlock })
	})
	return subscriptionOrFilterId
}

export async function getEthFilterChanges(filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) {
	const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
	const filter = filtersAndSubscriptions.find((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId)
	if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
	if (filter.params.params[0].blockhash !== undefined) throw new Error('blockhash not supported for this method')
	const calledInlastBlock = simulationState?.blockNumber || await ethereumClientService.getBlockNumber(requestAbortController)
	const logs = await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, { ...filter, fromBlock: filter.calledInlastBlock })
	await updateEthereumSubscriptionsAndFilters((subscriptionsAndfilters) => {
		return subscriptionsAndfilters.map((subscriptionOrfilter) => subscriptionOrfilter.subscriptionOrFilterId === filterId ? { ...subscriptionOrfilter, calledInlastBlock } : filter)
	})
	return logs
}

export async function getEthFilterLogs(filterId: string, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) {
	const filtersAndSubscriptions = await getEthereumSubscriptionsAndFilters()
	const filter = filtersAndSubscriptions.find((filter) => filter.subscriptionOrFilterId === filterId)
	if (filter === undefined || filter.type !== 'eth_newFilter') return undefined
	if (filter.params.params[0].blockhash !== undefined) throw new Error('blockhash not supported for this method')
	return await getSimulatedLogs(ethereumClientService, requestAbortController, simulationState, filter.params.params[0])
}
