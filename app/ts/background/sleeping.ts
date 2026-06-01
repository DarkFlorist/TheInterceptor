import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { modifyObject } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updateExtensionBadge } from './iconHandler.js'
import {
	getInterceptorStartSleepingTimestamp,
	getRpcConnectionStatus,
	setInterceptorStartSleepingTimestamp,
	setRpcConnectionStatus,
} from './storageVariables.js'
import { isConfirmTransactionFocused } from './windows/confirmTransaction.js'

let scheduledSleepCheck: ReturnType<typeof setTimeout> | undefined

const updateConnectionStatusRetry = async (
	ethereumClientService: EthereumClientService,
) => {
	const status = await getRpcConnectionStatus()
	if (status === undefined) return
	// This is used for sleep/wake retry-state transitions in addition to real RPC fetch failures.
	const rpcConnectionStatus = modifyObject(status, {
		retrying: ethereumClientService.isBlockPolling(),
	})
	await setRpcConnectionStatus(rpcConnectionStatus)
	await updateExtensionBadge()
	await sendPopupMessageToOpenWindows({
		method: 'popup_failed_to_get_block',
		data: { rpcConnectionStatus },
	})
}

export const makeSureInterceptorIsNotSleeping = async (
	ethereumClientService: EthereumClientService,
) => {
	const sleepDeadline = Date.now() + TIME_BETWEEN_BLOCKS * 2 * 1000
	await setInterceptorStartSleepingTimestamp(sleepDeadline)
	if (!ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor woke up! ⏰')
		ethereumClientService.setBlockPolling(true)
		await updateConnectionStatusRetry(ethereumClientService)
	}
	if (scheduledSleepCheck !== undefined) clearTimeout(scheduledSleepCheck)
	scheduledSleepCheck = setTimeout(
		() => {
			void checkIfInterceptorShouldSleep(ethereumClientService)
		},
		Math.max(0, sleepDeadline - Date.now()),
	)
}

const checkConfirmTransaction = async (
	ethereumClientService: EthereumClientService,
) => {
	if (await isConfirmTransactionFocused())
		makeSureInterceptorIsNotSleeping(ethereumClientService)
}

export const checkIfInterceptorShouldSleep = async (
	ethereumClientService: EthereumClientService,
) => {
	await checkConfirmTransaction(ethereumClientService)
	const startSleping = await getInterceptorStartSleepingTimestamp()
	if (startSleping < Date.now() && ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor started to sleep 😴')
		ethereumClientService.setBlockPolling(false)
		if (scheduledSleepCheck !== undefined) {
			clearTimeout(scheduledSleepCheck)
			scheduledSleepCheck = undefined
		}
		await updateConnectionStatusRetry(ethereumClientService)
	}
}
