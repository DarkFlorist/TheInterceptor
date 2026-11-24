import { keccak256, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { parseTransaction, recoverTransactionSender } from '../../app/ts/utils/ethereumTransactions.js'

const quantity = (value: bigint | number) => `0x${ BigInt(value).toString(16) }`

// A node's eth_getTransactionByHash answer for a signed EIP-1559 transaction that is still waiting in its pool.
export function pendingTransactionResult(signedTransaction: Hex) {
	const transaction = parseTransaction(signedTransaction)
	if (transaction.r === undefined || transaction.s === undefined || transaction.yParity === undefined) throw new Error('Expected a signed transaction')
	return {
		type: '0x2', hash: keccak256(signedTransaction), from: recoverTransactionSender(signedTransaction), chainId: quantity(transaction.chainId), nonce: quantity(transaction.nonce),
		maxFeePerGas: quantity(transaction.maxFeePerGas), maxPriorityFeePerGas: quantity(transaction.maxPriorityFeePerGas), gasPrice: quantity(transaction.maxFeePerGas), gas: quantity(transaction.gas),
		to: transaction.to ?? null, value: quantity(transaction.value ?? 0n), input: transaction.data ?? '0x', accessList: [],
		r: transaction.r, s: transaction.s, yParity: quantity(transaction.yParity),
		blockHash: null, blockNumber: null, transactionIndex: null,
	}
}

// A node's eth_getTransactionReceipt answer for a signed EIP-1559 transaction mined in block 1.
export function minedReceiptResult(signedTransaction: Hex, succeeded: boolean) {
	const transaction = parseTransaction(signedTransaction)
	return {
		type: '0x2', transactionHash: keccak256(signedTransaction), transactionIndex: '0x0', blockHash: `0x${ '11'.repeat(32) }`, blockNumber: '0x1',
		from: recoverTransactionSender(signedTransaction), to: transaction.to ?? null, contractAddress: null,
		cumulativeGasUsed: quantity(transaction.gas), gasUsed: quantity(transaction.gas), effectiveGasPrice: quantity(transaction.maxFeePerGas),
		logs: [], logsBloom: `0x${ '00'.repeat(256) }`, status: succeeded ? '0x1' : '0x0',
	}
}
