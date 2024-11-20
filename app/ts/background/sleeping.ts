import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { modifyObject } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updateExtensionBadge } from './iconHandler.js'
import { getInterceptorStartSleepingTimestamp, getRpcConnectionStatus, setInterceptorStartSleepingTimestamp, setRpcConnectionStatus } from './storageVariables.js'
import { isConfirmTransactionFocused } from './windows/confirmTransaction.js'

const updateConnectionStatusRetry = async (ethereumClientService: EthereumClientService) => {
	const status = await getRpcConnectionStatus()
	if (status === undefined) return
	const rpcConnectionStatus = modifyObject(status, { retrying: ethereumClientService.isBlockPolling() })
	await setRpcConnectionStatus(rpcConnectionStatus)
	await updateExtensionBadge()
	await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
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
