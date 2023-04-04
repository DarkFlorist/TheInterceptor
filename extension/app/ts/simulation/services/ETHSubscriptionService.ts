import { EthSubscribeParams, JsonRpcMessage, JsonRpcNewHeadsNotification } from '../../utils/wire-types.js'
import { ErrorWithData } from '../../utils/errors.js'
import { Future } from '../../utils/future.js'

type Subscription = {
	callback: (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => void
	params: EthSubscribeParams,
	rpcSocket: WebSocket
}

export class ETHSubscriptionService {
	private subscriptions = new Map<string, Subscription>()
	private subscriptionSocket = new Map<WebSocket, string>()

	private webSocketConnectionString: string

	public constructor(webSocketConnectionString: string) {
		this.webSocketConnectionString = webSocketConnectionString
	}

	public readonly remoteSubscription = (subscriptionId: string) => {
		if(this.subscriptions.has(subscriptionId)) {
			this.subscriptions.get(subscriptionId)?.rpcSocket.close()
			this.subscriptions.delete(subscriptionId)
			return true
		}
		return false
	}

	public readonly createSubscription = async (params: EthSubscribeParams, callback: (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => void) => {
		switch(params.params[0]) {
			case 'newHeads': {
				const rpcSocket = new WebSocket(this.webSocketConnectionString)
				const subscriptionId = new Future<string>()

				rpcSocket.addEventListener('open', _event => {
					const request = { jsonrpc: '2.0', id: 0, method: 'eth_subscribe', params: ['newHeads'] }
					rpcSocket.send(JSON.stringify(request))
				})

				rpcSocket.addEventListener('close', event => {
					if (event.code === 1000) return
					if (this.subscriptionSocket.has(rpcSocket)) {
						this.subscriptions.delete(this.subscriptionSocket.get(rpcSocket)!)
						this.subscriptionSocket.delete(rpcSocket)
					}
					throw new Error(`Websocket disconnected with code ${event.code} and reason: ${event.reason}`)
				})

				rpcSocket.addEventListener('message', event => {
					const subResponse = JsonRpcMessage.parse(JSON.parse(event.data))
					if ('error' in subResponse) {
						throw new ErrorWithData(`Websocket error`, subResponse.error)
					}
					if ('id' in subResponse && 'result' in subResponse) {
						if (typeof subResponse.result !== 'string') throw new ErrorWithData(`Expected rpc payload to be a string but it was a ${typeof event.data}`, event.data)
						return subscriptionId.resolve(subResponse.result)
					}
					try {
						if (typeof event.data !== 'string') throw new ErrorWithData(`Expected rpc payload to be a string but it was a ${typeof event.data}`, event.data)
						const jsonRpcNotification = JsonRpcNewHeadsNotification.parse(JSON.parse(event.data))
						if (jsonRpcNotification['method'] === 'eth_subscription') {
							return callback(jsonRpcNotification.params.subscription, jsonRpcNotification)
						} else {
							throw('not eth_subscription')
						}
					} catch (error: unknown) {
						console.error(error)
					}
				})

				rpcSocket.addEventListener('error', event => {
					throw new ErrorWithData(`Websocket error`, event)
				})

				const subId = await subscriptionId

				this.subscriptions.set(subId, {
					callback: callback,
					params: params,
					rpcSocket: rpcSocket
				})
				this.subscriptionSocket.set(rpcSocket, subId)

				return subId
			}
			case 'logs': throw `Dapp requested for 'logs' subscription but it's not implemented`
			case 'newPendingTransactions': throw `Dapp requested for 'newPendingTransactions' subscription but it's not implemented`
			case 'syncing': throw `Dapp requested for 'syncing' subscription but it's not implemented`
		}
	}
}