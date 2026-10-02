import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import { min } from './bigint.js'

const getAffordableTransactionFees = (desiredMaxFeePerGas: bigint, desiredMaxPriorityFeePerGas: bigint, balance: bigint, value: bigint, gasLimit: bigint) => {
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

export type RequestedTransactionFees = {
	readonly feeModel: 'legacy' | 'fee-market'
	readonly maxFeePerGas: bigint | undefined
	readonly maxPriorityFeePerGas: bigint
	readonly adjustForBaseFee: boolean
}

// Own the conversion once: explicit legacy prices become equal simulation caps and must never be repriced as base fees change.
export function getRequestedTransactionFees(details: Pick<SendTransactionParams['params'][0], 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>): RequestedTransactionFees {
	if (details.gasPrice !== undefined) return { feeModel: 'legacy', maxFeePerGas: details.gasPrice, maxPriorityFeePerGas: details.gasPrice, adjustForBaseFee: false }
	return {
		feeModel: 'fee-market',
		maxFeePerGas: details.maxFeePerGas ?? undefined,
		maxPriorityFeePerGas: details.maxPriorityFeePerGas ?? 10n ** 8n, // 0.1 nanoeth/gas
		adjustForBaseFee: !hasExplicitMaxFeePerGas(details.maxFeePerGas),
	}
}
