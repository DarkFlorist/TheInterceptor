export const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
export const INTERCEPTOR_BRIDGE_INITIALIZED_MESSAGE = 'interceptor_bridge_initialized'
export const INTERCEPTOR_BRIDGE_RECONNECTED_MESSAGE = 'interceptor_bridge_reconnected'
export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'
export const INTERCEPTOR_PRIVATE_BRIDGE_EVENT = 'interceptor_private_bridge'

export const INTERCEPTOR_SIGNER_DOCUMENT_GENERATION_MESSAGE = 'interceptor_signer_document_generation'
export const INTERCEPTOR_SIGNER_DOCUMENT_PROBE_METHOD = 'interceptor_signer_document_probe'

export type InpageBridgeInitializer = (secret: string) => boolean

declare global {
	var __interceptorInitializeBridge: InpageBridgeInitializer | undefined
}

// Only the MAIN realm installs this entry point. The invocation function is serialized by Chrome and must have no runtime module dependencies.
export function installInpageBridgeInitializer(target: object, initialize: InpageBridgeInitializer) {
	Object.defineProperty(target, '__interceptorInitializeBridge', { value: initialize })
}

export function invokeInpageBridgeInitializer(secret: unknown) {
	if (typeof secret !== 'string') throw new Error('Missing inpage bootstrap key')
	return typeof __interceptorInitializeBridge === 'function' ? __interceptorInitializeBridge(secret) : false
}
