export const RPC_CONFIGURATION_UNAVAILABLE_MESSAGE = 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.'
export const RPC_CONFIGURATION_UNAVAILABLE_CODE = 'rpc_configuration_unavailable'

export type RpcConfigurationUnavailableError = Error & {
	readonly code: typeof RPC_CONFIGURATION_UNAVAILABLE_CODE
}

export function createRpcConfigurationUnavailableError(): RpcConfigurationUnavailableError {
	const metadata: Pick<RpcConfigurationUnavailableError, 'code'> = { code: RPC_CONFIGURATION_UNAVAILABLE_CODE }
	return Object.assign(new Error(RPC_CONFIGURATION_UNAVAILABLE_MESSAGE), metadata)
}

export function isRpcConfigurationUnavailableError(error: unknown): error is RpcConfigurationUnavailableError {
	return error instanceof Error && 'code' in error && error.code === RPC_CONFIGURATION_UNAVAILABLE_CODE
}
