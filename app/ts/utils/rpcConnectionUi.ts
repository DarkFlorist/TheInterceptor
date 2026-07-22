import type { RpcConnectionStatus, RpcSlowRequest } from '../types/user-interface-types.js'
import { type RpcEntries, RpcEntry } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { TIME_BETWEEN_BLOCKS } from './constants.js'

type RpcWarningBase = {
	retryState: 'active' | 'paused'
	nextRetryAt: Date | undefined
}

export type RpcWarningState = RpcWarningBase & (
	| { kind: 'none' | 'disconnected' | 'stalled' }
	| { kind: 'slowRequest', slowRequest: RpcSlowRequest }
)

export function noNewBlockForOverTwoMins(connectionStatus: RpcConnectionStatus) {
	return connectionStatus?.latestBlock !== undefined
		&& connectionStatus.latestBlock !== null
		&& (connectionStatus.lastConnnectionAttempt.getTime() - connectionStatus.latestBlock.timestamp.getTime()) > 2 * 60 * 1000
}

export function getNextRpcRetryAt(connectionStatus: RpcConnectionStatus) {
	if (connectionStatus === undefined) return undefined
	return new Date(connectionStatus.lastConnnectionAttempt.getTime() + TIME_BETWEEN_BLOCKS * 1000)
}

export function getRpcWarningState(connectionStatus: RpcConnectionStatus): RpcWarningState {
	if (connectionStatus === undefined) {
		return {
			kind: 'none',
			retryState: 'paused',
			nextRetryAt: undefined,
		}
	}
	const retryState = connectionStatus.retrying ? 'active' : 'paused'
	const nextRetryAt = getNextRpcRetryAt(connectionStatus)
	if (connectionStatus.isConnected === false) return { kind: 'disconnected', retryState, nextRetryAt }
	if (connectionStatus.slowRequest !== undefined) return { kind: 'slowRequest', retryState, nextRetryAt: undefined, slowRequest: connectionStatus.slowRequest }
	if (connectionStatus.retrying && noNewBlockForOverTwoMins(connectionStatus)) return { kind: 'stalled', retryState, nextRetryAt }
	return { kind: 'none', retryState, nextRetryAt }
}

export function shouldShowRpcWarningCountdown(warningState: RpcWarningState, now: Date = new Date()) {
	return warningState.retryState === 'active'
		&& warningState.nextRetryAt !== undefined
		&& warningState.nextRetryAt.getTime() > now.getTime()
}

export function shouldOfferBundledRpcReset(rpcEntries: RpcEntries, bundledRpcEntries: RpcEntries) {
	if (rpcEntries.length !== 1) return false
	if (rpcEntries.length !== bundledRpcEntries.length) return true
	return rpcEntries.some((entry, index) => {
		const bundledEntry = bundledRpcEntries[index]
		return bundledEntry === undefined || JSON.stringify(serialize(RpcEntry, entry)) !== JSON.stringify(serialize(RpcEntry, bundledEntry))
	})
}
