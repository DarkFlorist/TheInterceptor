import { EthereumClientService } from "../simulation/services/EthereumClientService.js"
import { TIME_BETWEEN_BLOCKS } from "../utils/constants.js"
import { getInterceptorStartSleepingTimestamp, setInterceptorStartSleepingTimestamp } from "./storageVariables.js"

export const makeSureInterceptorIsNotSleeping = (ethereumClientService: EthereumClientService) => {
	setInterceptorStartSleepingTimestamp(Date.now() + TIME_BETWEEN_BLOCKS * 2 * 1000)
	if (!ethereumClientService.isBlockPolling()) {
		console.log('The Interceptor woke up! ⏰')
		ethereumClientService.setBlockPolling(true)
	}
}

export const checkIfInterceptorShouldSleep = async (ethereumClientService: EthereumClientService) => {
	const startSleping = await getInterceptorStartSleepingTimestamp()
	if (startSleping < Date.now() && ethereumClientService.isBlockPolling()) {
		console.log('The Interceptor started to sleep 😴')
		ethereumClientService.setBlockPolling(false)
	}
}
