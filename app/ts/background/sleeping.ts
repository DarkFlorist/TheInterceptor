import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { modifyObject } from '../utils/typescript.js'
import { getInterceptorStartSleepingTimestamp, getRpcConnectionStatus, setInterceptorStartSleepingTimestamp } from './storageVariables.js'
import { isConfirmTransactionFocused } from './windows/confirmTransaction.js'
import type { DefinedRpcConnectionStatus, RpcConnectionStatusChangeMethod } from './rpcSlowRequestTracking.js'

type PublishRpcConnectionStatus = (method: RpcConnectionStatusChangeMethod, rpcConnectionStatus: DefinedRpcConnectionStatus) => Promise<void>
let publishRpcConnectionStatus: PublishRpcConnectionStatus | undefined

export function setRpcConnectionStatusRetryPublisher(publisher: PublishRpcConnectionStatus) {
	publishRpcConnectionStatus = publisher
}

const updateConnectionStatusRetry = async (ethereumClientService: EthereumClientService) => {
	const status = await getRpcConnectionStatus()
	if (status === undefined) return
	if (publishRpcConnectionStatus === undefined) throw new Error('RPC connection status retry publisher has not been configured.')
	// This is used for sleep/wake retry-state transitions in addition to real RPC fetch failures.
	const rpcConnectionStatus = modifyObject(status, { retrying: ethereumClientService.isBlockPolling() })
	await publishRpcConnectionStatus('popup_failed_to_get_block', rpcConnectionStatus)
}

export const makeSureInterceptorIsNotSleeping = async (ethereumClientService: EthereumClientService) => {
	setInterceptorStartSleepingTimestamp(Date.now() + TIME_BETWEEN_BLOCKS * 2 * 1000)
	if (!ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor woke up! ⏰')
		ethereumClientService.setBlockPolling(true)
		await updateConnectionStatusRetry(ethereumClientService)
	}
}

const checkConfirmTransaction = async (ethereumClientService: EthereumClientService) => {
	if (await isConfirmTransactionFocused()) makeSureInterceptorIsNotSleeping(ethereumClientService)
}

export const checkIfInterceptorShouldSleep = async (ethereumClientService: EthereumClientService) => {
	await checkConfirmTransaction(ethereumClientService)
	const startSleping = await getInterceptorStartSleepingTimestamp()
	if (startSleping < Date.now() && ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor started to sleep 😴')
		ethereumClientService.setBlockPolling(false)
		await updateConnectionStatusRetry(ethereumClientService)
	}
}
