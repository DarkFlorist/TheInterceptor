import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { modifyObject } from '../utils/typescript.js'
import { getInterceptorStartSleepingTimestamp, getRpcConnectionStatus, setInterceptorStartSleepingTimestamp } from './storageVariables.js'
import { isConfirmTransactionFocused } from './windows/confirmTransaction.js'
import type { DefinedRpcConnectionStatus, RpcConnectionStatusChangeMethod } from './rpcSlowRequestTracking.js'

export type PublishRpcConnectionStatus = (method: RpcConnectionStatusChangeMethod, rpcConnectionStatus: DefinedRpcConnectionStatus) => Promise<void>

const updateConnectionStatusRetry = async (ethereumClientService: EthereumClientService, publishRpcConnectionStatus: PublishRpcConnectionStatus) => {
	const status = await getRpcConnectionStatus()
	if (status === undefined) return
	// This is used for sleep/wake retry-state transitions in addition to real RPC fetch failures.
	const rpcConnectionStatus = modifyObject(status, { retrying: ethereumClientService.isBlockPolling() })
	await publishRpcConnectionStatus('popup_failed_to_get_block', rpcConnectionStatus)
}

export const makeSureInterceptorIsNotSleeping = async (ethereumClientService: EthereumClientService, publishRpcConnectionStatus: PublishRpcConnectionStatus) => {
	setInterceptorStartSleepingTimestamp(Date.now() + TIME_BETWEEN_BLOCKS * 2 * 1000)
	if (!ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor woke up! ⏰')
		ethereumClientService.setBlockPolling(true)
		await updateConnectionStatusRetry(ethereumClientService, publishRpcConnectionStatus)
	}
}

const checkConfirmTransaction = async (ethereumClientService: EthereumClientService, publishRpcConnectionStatus: PublishRpcConnectionStatus) => {
	if (await isConfirmTransactionFocused()) await makeSureInterceptorIsNotSleeping(ethereumClientService, publishRpcConnectionStatus)
}

export const checkIfInterceptorShouldSleep = async (ethereumClientService: EthereumClientService, publishRpcConnectionStatus: PublishRpcConnectionStatus) => {
	await checkConfirmTransaction(ethereumClientService, publishRpcConnectionStatus)
	const startSleping = await getInterceptorStartSleepingTimestamp()
	if (startSleping < Date.now() && ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor started to sleep 😴')
		ethereumClientService.setBlockPolling(false)
		await updateConnectionStatusRetry(ethereumClientService, publishRpcConnectionStatus)
	}
}
