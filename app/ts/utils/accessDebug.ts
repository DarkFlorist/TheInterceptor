import { addressString } from './bigint.js'

const ACCESS_DEBUG_ENABLED = false
const BACKGROUND_ACCESS_DEBUG_PREFIX = '[Interceptor access debug]'

const logAccessDebug = (prefix: string, message: string, details: Record<string, unknown>) => {
	if (!ACCESS_DEBUG_ENABLED) return
	console.warn(prefix, message, details)
}

export const formatDebugAddress = (address: bigint | undefined) => address === undefined ? undefined : addressString(address)

export const logBackgroundAccessDebug = (message: string, details: Record<string, unknown>) => {
	logAccessDebug(BACKGROUND_ACCESS_DEBUG_PREFIX, message, details)
}
