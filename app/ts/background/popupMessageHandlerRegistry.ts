import type { SimulationServicesOwner, SimulationServices } from '../simulation/serviceLifecycle.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { type NetworkSnapshot, readNetworkSnapshot } from './networkTransitionLock.js'

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	simulationServicesOwner: SimulationServicesOwner
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
export type PopupMessageHandlerMap = Record<PopupMessage['method'], PopupMessageHandler>
export const popupMessageHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

// For handlers that simulate or write the stack: settings, stack and services read together under the transition lock. The context exposes neither reset nor the live owner.
export type PopupSnapshotContext = Omit<PopupMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly network: NetworkSnapshot
}

export function popupSnapshotMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		return await handler({ ...executionContext, network: await readNetworkSnapshot(simulationServicesOwner) }, request)
	})
}

// For lookups that read neither the stack nor the settings, such as identifying an address or reading a Gnosis Safe: the installed services, taken without the network lock, so these dialogs neither wait for a network change nor fail while one cannot be completed. During a change they may describe the network being replaced, which only changes what a lookup shows.
export type PopupLookupContext = Omit<PopupMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly services: SimulationServices
}

export function popupLookupMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupLookupContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		return await handler({ ...executionContext, services: simulationServicesOwner.getCurrent() }, request)
	})
}
