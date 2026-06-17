import { min } from './bigint.js'

export const getAffordableTransactionFees = (desiredMaxFeePerGas: bigint, desiredMaxPriorityFeePerGas: bigint, balance: bigint, value: bigint, gasLimit: bigint) => {
	if (gasLimit === 0n) return { maxFeePerGas: desiredMaxFeePerGas, maxPriorityFeePerGas: desiredMaxPriorityFeePerGas }
	const availableForGas = balance > value ? balance - value : 0n
	const maxFeePerGas = min(desiredMaxFeePerGas, availableForGas / gasLimit)
	return {
		maxFeePerGas,
		maxPriorityFeePerGas: min(desiredMaxPriorityFeePerGas, maxFeePerGas),
	}
}
