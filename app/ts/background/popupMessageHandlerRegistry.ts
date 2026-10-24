import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { readNetworkSnapshot } from './activeSettings.js'
import type { SimulationSnapshot } from './simulationUpdating.js'

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	simulationServicesOwner: SimulationServicesOwner
	settings: Settings
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
export type PopupMessageHandlerMap = Record<PopupMessage['method'], PopupMessageHandler>
export const popupMessageHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

// One fixed-provider operation: settings, stack and services are read together under the transition lock, and the context exposes neither reset nor the live owner.
export type PopupSnapshotContext = Omit<PopupMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly services: SimulationServices
	readonly simulation: SimulationSnapshot
}

export function popupSnapshotMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		const { settings, simulation, services } = await readNetworkSnapshot(simulationServicesOwner)
		return await handler({ ...executionContext, settings, simulation, services }, request)
	})
}
