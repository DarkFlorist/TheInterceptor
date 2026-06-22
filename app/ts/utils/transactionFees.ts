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

export const hasExplicitMaxFeePerGas = (maxFeePerGas: bigint | null | undefined): maxFeePerGas is bigint => maxFeePerGas !== undefined && maxFeePerGas !== null

export const getDesiredMaxFeePerGasForBaseFee = (parentBaseFeePerGas: bigint, maxPriorityFeePerGas: bigint) => parentBaseFeePerGas * 2n + maxPriorityFeePerGas

export const getTransactionFeesForBaseFee = (
	parentBaseFeePerGas: bigint,
	maxPriorityFeePerGas: bigint,
	maxFeePerGas: bigint | null | undefined,
	balance: bigint,
	value: bigint,
	gasLimit: bigint,
) => {
	if (hasExplicitMaxFeePerGas(maxFeePerGas)) return {
		maxFeePerGas,
		maxPriorityFeePerGas,
	}
	return getAffordableTransactionFees(getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas), maxPriorityFeePerGas, balance, value, gasLimit)
}
