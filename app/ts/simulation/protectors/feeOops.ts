import type { WebsiteCreatedEthereumTransaction } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'

export async function feeOops(request: Pick<WebsiteCreatedEthereumTransaction, 'transaction' | 'originalRequestParameters'>, ethereum: Pick<EthereumClientService, 'getGasPrice'>, requestAbortController: AbortController | undefined) {
	const { transaction, originalRequestParameters } = request
	const usesFeeCaps = transaction.type === '1559' || transaction.type === '4844' || transaction.type === '7702'
	// Simulation normalizes legacy gasPrice into equal fee caps. Its full price must still use the legacy market-price comparison, not the priority-fee threshold.
	const hasLegacyGasPrice = originalRequestParameters.method === 'eth_sendTransaction' && originalRequestParameters.params[0].gasPrice !== undefined
	if (usesFeeCaps && !hasLegacyGasPrice) {
		if (transaction.maxPriorityFeePerGas < 10n ** 9n * 10n) return // 10.0 nanoeth/gas
		return `Attempt to send a transaction with an outrageous fee (${ transaction.maxPriorityFeePerGas / (10n ** 9n) } nanoeth/gas)`
	}
	const gasPrice = usesFeeCaps ? transaction.maxFeePerGas : transaction.gasPrice
	if (gasPrice === 0n) return
	const estimatedGasPrice = await ethereum.getGasPrice(requestAbortController)
	if (gasPrice < estimatedGasPrice * 10n) return // 10 times the estimated gas price
	return `Attempt to send a transaction with an outrageous fee. Gas price: ${ gasPrice } attoeth/gas`
}
