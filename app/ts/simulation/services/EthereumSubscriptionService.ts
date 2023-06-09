import { EthSubscribeParams, NewHeadsSubscriptionData } from '../../utils/wire-types.js'
import { assertNever } from '../../utils/typescript.js'
import { EthereumClientService } from './EthereumClientService.js'
import { getEthereumSubscriptions, updateEthereumSubscriptions } from '../../background/storageVariables.js'
import { EthereumSubscriptions, SimulationState } from '../../utils/visualizer-types.js'
import { postMessageIfStillConnected } from '../../background/background.js'
import { WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { getSimulatedBlock } from './SimulationModeEthereumClientService.js'

const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

function generateId(len: number) {
	const arr = new Uint8Array((len || 40) / 2)
	globalThis.crypto.getRandomValues(arr)
	return `0x${ Array.from(arr, dec2hex).join('') }`
}

export async function removeEthereumSubscription(socket: WebsiteSocket, subscriptionId: string) {
	await updateEthereumSubscriptions((subscriptions: EthereumSubscriptions) => {
		return subscriptions.filter((subscription) => subscription.subscriptionId !== subscriptionId
			&& subscription.subscriptionCreatorSocket.tabId === socket.tabId // only allow the same tab and connection to remove the subscription
			&& subscription.subscriptionCreatorSocket.connectionName === socket.connectionName
		)
	})
}

export async function sendSubscriptionMessagesForNewBlock(blockNumber: bigint, ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, websiteTabConnections: WebsiteTabConnections) {
	const ethereumSubscriptions = await getEthereumSubscriptions()
	for (const subscription of ethereumSubscriptions) {
		switch (subscription.type) {
			case 'newHeads': {
				if (websiteTabConnections.get(subscription.subscriptionCreatorSocket.tabId) === undefined) { // connection removed
					return await removeEthereumSubscription(subscription.subscriptionCreatorSocket, subscription.subscriptionId)
				}
				const newBlock = await ethereumClientService.getBlock(blockNumber, false)

				postMessageIfStillConnected(websiteTabConnections, subscription.subscriptionCreatorSocket, {
					interceptorApproved: true,
					options: subscription.params,
					result: NewHeadsSubscriptionData.serialize({ subscription: subscription.type, result: newBlock }),
					subscription: subscription.subscriptionId,
				})

				if (simulationState !== undefined) {
					const simulatedBlock = await getSimulatedBlock(ethereumClientService, simulationState, blockNumber + 1n, false)
					// post our simulated block on top (reorg it)
					postMessageIfStillConnected(websiteTabConnections, subscription.subscriptionCreatorSocket, {
						interceptorApproved: true,
						options: subscription.params,
						result: NewHeadsSubscriptionData.serialize({ subscription: subscription.type, result: simulatedBlock }),
						subscription: subscription.subscriptionId,
					})
				}
				return
			}
			default: assertNever(subscription.type)
		}
	}
	return
}
export async function createEthereumSubscription(params: EthSubscribeParams, subscriptionCreatorSocket: WebsiteSocket) {
	console.log('createsub tabid', subscriptionCreatorSocket.tabId)
	switch(params.params[0]) {
		case 'newHeads': {
			const subscriptionId = generateId(40)
			await updateEthereumSubscriptions((subscriptions: EthereumSubscriptions) => {
				return subscriptions.concat({ type: 'newHeads', subscriptionId, params, subscriptionCreatorSocket })
			})
			return subscriptionId
		}
		case 'logs': throw `Dapp requested for 'logs' subscription but it's not implemented` //TODO: implement
		case 'newPendingTransactions': throw `Dapp requested for 'newPendingTransactions' subscription but it's not implemented` //TODO: implement
		case 'syncing': throw `Dapp requested for 'syncing' subscription but it's not implemented` //TODO: implement
	}
}
