// Wire identities shared by the isolated listener, MAIN-world provider and background receiver.
export const INTERCEPTOR_BRIDGE_PORT_MESSAGE = 'interceptor_bridge_port'
export const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
export const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'
export const INTERCEPTOR_DIAGNOSTIC_REQUEST = { requestId: -1, method: 'InterceptorError' } as const
