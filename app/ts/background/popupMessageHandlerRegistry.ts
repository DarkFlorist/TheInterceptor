import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { getRpcServicesAtAdmission } from './rpcConfigurationAvailability.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from '../types/interceptor-reply-messages.js'

const rpcConfigurationUnavailableReply = (): PopupReplyOption => ({ error: RPC_CONFIGURATION_UNAVAILABLE_ERROR })

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	simulationServicesOwner: SimulationServicesOwner
	settings: Settings | undefined
	rpcConfiguration: RpcConfigurationState
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
export type PopupMessageHandlerMap = Record<PopupMessage['method'], PopupMessageHandler>
export type PopupReadyMessageDispatcherContext = Omit<PopupMessageDispatcherContext, 'settings'> & { readonly settings: Settings }

const popupMethodHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

export function popupMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupReadyMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
	settingsUnavailableReply: (request: Extract<PopupMessage, { readonly method: Method }>) => PopupReplyOption = () => rpcConfigurationUnavailableReply(),
): PopupMessageHandler {
	return popupMethodHandler(method, async (context, request) => {
		if (context.settings === undefined) return settingsUnavailableReply(request)
		return await handler({ ...context, settings: context.settings }, request)
	})
}

export function popupRecoveryMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMethodHandler(method, handler)
}

// Lifecycle commands are the only RPC-backed popup operations allowed to retain the live owner. Fixed-provider operations belong in popupSnapshotMessageHandler.
export function popupRpcLifecycleMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupReadyMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		if (getRpcServicesAtAdmission(context.rpcConfiguration, context.simulationServicesOwner) === undefined) return rpcConfigurationUnavailableReply()
		return await handler(context, request)
	})
}

// One fixed-provider operation: this context deliberately exposes neither reset nor the live owner.
export type PopupSnapshotContext = Omit<PopupReadyMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly services: SimulationServices
}

export function popupSnapshotMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
	unavailableReply: (request: Extract<PopupMessage, { readonly method: Method }>) => PopupReplyOption = () => rpcConfigurationUnavailableReply(),
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		const services = getRpcServicesAtAdmission(context.rpcConfiguration, simulationServicesOwner)
		if (services === undefined) return unavailableReply(request)
		return await handler({ ...executionContext, services }, request)
	}, unavailableReply)
}

export type PopupOptionalSnapshotContext = Omit<PopupReadyMessageDispatcherContext, 'resetSimulationState'> & {
	readonly services: SimulationServices | undefined
}

// Mixed commands can remain available offline while declaring exactly which request variants require an admitted service snapshot.
export function popupOptionalSnapshotMessageHandler<Method extends PopupMessage['method']>(
	method: Method,
	handler: (context: PopupOptionalSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
	requiresRpc: (request: Extract<PopupMessage, { readonly method: Method }>) => boolean,
	unavailableReply: (request: Extract<PopupMessage, { readonly method: Method }>) => PopupReplyOption,
): PopupMessageHandler {
	return popupMessageHandler(method, async (context, request) => {
		const { resetSimulationState: _resetSimulationState, ...executionContext } = context
		const services = getRpcServicesAtAdmission(context.rpcConfiguration, context.simulationServicesOwner)
		if (requiresRpc(request) && services === undefined) return unavailableReply(request)
		return await handler({ ...executionContext, services }, request)
	}, unavailableReply)
}
