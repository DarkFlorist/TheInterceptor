import type { Protector } from '../protectorTypes.js'
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

// Bind the fee-only input at assembly time so the runner and other protectors need no fee-policy fields.
export function createFeeProtector(input: FeeProtectionInput): Protector {
	return async (_transaction, ethereum, requestAbortController) => await feeOops(input, ethereum, requestAbortController)
}
