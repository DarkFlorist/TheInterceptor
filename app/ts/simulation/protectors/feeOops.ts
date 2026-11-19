import type { ProtectorRequestContext } from '../protectorTypes.js'
import { getFeeProtectionInput } from '../feeProtection.js'
import { getRequestedTransactionFees } from '../../utils/transactionFees.js'
import type { FeeProtectionInput } from '../feeProtection.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'

export async function feeOops({ comparison, pricePerGas }: FeeProtectionInput, ethereum: Pick<EthereumClientService, 'getGasPrice'>, requestAbortController: AbortController | undefined) {
	if (comparison === 'priority-fee') {
		if (pricePerGas < 10n ** 9n * 10n) return // 10.0 nanoeth/gas
		return `Attempt to send a transaction with an outrageous fee (${ pricePerGas / (10n ** 9n) } nanoeth/gas)`
	}
	if (pricePerGas === 0n) return
	const estimatedGasPrice = await ethereum.getGasPrice(requestAbortController)
	if (pricePerGas < estimatedGasPrice * 10n) return // 10 times the estimated gas price
	return `Attempt to send a transaction with an outrageous fee. Gas price: ${ pricePerGas } attoeth/gas`
}

// Fee policy is derived here from the original request, not by pipeline callers.
export async function checkRequestedTransactionFees({ transaction, originalRequestParameters }: ProtectorRequestContext, ethereum: Pick<EthereumClientService, 'getGasPrice'>, requestAbortController: AbortController | undefined) {
	const requestedFees = originalRequestParameters.method === 'eth_sendTransaction' ? getRequestedTransactionFees(originalRequestParameters.params[0]) : undefined
	return await feeOops(getFeeProtectionInput(transaction, requestedFees), ethereum, requestAbortController)
}
