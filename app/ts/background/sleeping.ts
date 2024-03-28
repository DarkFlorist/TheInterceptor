import { EthereumClientService } from "../simulation/services/EthereumClientService.js"
import { TIME_BETWEEN_BLOCKS } from "../utils/constants.js"
import { getInterceptorStartSleepingTimestamp, setInterceptorStartSleepingTimestamp } from "./storageVariables.js"
import { isConfirmTransactionFocused } from "./windows/confirmTransaction.js"

export const makeSureInterceptorIsNotSleeping = (ethereumClientService: EthereumClientService) => {
	setInterceptorStartSleepingTimestamp(Date.now() + TIME_BETWEEN_BLOCKS * 2 * 1000)
	if (!ethereumClientService.isBlockPolling()) {
		console.info('The Interceptor woke up! ⏰')
		ethereumClientService.setBlockPolling(true)
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
	}
}
