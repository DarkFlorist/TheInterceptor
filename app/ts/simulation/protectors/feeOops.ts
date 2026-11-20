import type { ProtectorChainReads } from '../protectorChainReads.js'
import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'

export async function feeOops(transaction: EthereumUnsignedTransaction, _connectedChainId: bigint, chainReads: ProtectorChainReads) {
	if (transaction.type === '1559' || transaction.type === '4844' || transaction.type === '7702') {
		if (transaction.maxPriorityFeePerGas < 10n ** 9n * 10n) return // 10.0 nanoeth/gas
		return `Attempt to send a transaction with an outrageous fee (${ transaction.maxPriorityFeePerGas / (10n ** 9n) } nanoeth/gas)`
	}
	const gasPrice = await chainReads.readGasPrice()
	if (transaction.gasPrice < gasPrice * 10n) return // 10 times the estimate gas price
	return `Attempt to send a transaction with an outrageous fee. GasPrice: ${ gasPrice }`
}
