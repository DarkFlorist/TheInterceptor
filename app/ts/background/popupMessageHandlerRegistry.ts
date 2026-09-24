import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { rpcServicesAreAvailable } from './rpcConfigurationLifecycle.js'

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	simulationServicesOwner: SimulationServicesOwner
	settings: Settings
	rpcConfiguration: RpcConfigurationState
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
export type PopupMessageHandlerMap = Record<PopupMessage['method'], PopupMessageHandler>
export const popupMessageHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

export function popupRpcMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
	unavailableReply?: (request: Extract<PopupMessage, { readonly method: Method }>) => PopupReplyOption,
	requiresRpc: (request: Extract<PopupMessage, { readonly method: Method }>) => boolean = () => true,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		if (requiresRpc(request) && !rpcServicesAreAvailable(context.rpcConfiguration, context.simulationServicesOwner)) return unavailableReply?.(request)
		return await handler(context, request)
	})
}

// One fixed-provider operation: this context deliberately exposes neither reset nor the live owner.
export type PopupSnapshotContext = Omit<PopupMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly services: SimulationServices
}

export function popupSnapshotMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupRpcMessageHandler(method, async (context, request) => {
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		const services = simulationServicesOwner.getCurrentOrUndefined()
		if (services === undefined) return
		return await handler({ ...executionContext, services }, request)
	})
}
