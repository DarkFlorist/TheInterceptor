import type { BlockTimeManipulationDeltaUnit } from '../../types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { max, min } from '../../utils/bigint.js'
import { ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER } from '../../utils/constants.js'
import { assertNever } from '../../utils/typescript.js'

export const calculateRealizedEffectiveGasPrice = (transaction: EthereumUnsignedTransaction, blocksBaseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) return transaction.gasPrice
	return min(blocksBaseFeePerGas + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

export const getBlockTimeManipulationSeconds = (deltaToAdd: bigint, deltaUnit: BlockTimeManipulationDeltaUnit) => {
	switch(deltaUnit) {
		case 'Seconds': return deltaToAdd
		case 'Minutes': return deltaToAdd * 60n
		case 'Hours': return deltaToAdd * 60n * 60n
		case 'Days': return deltaToAdd * 60n * 60n * 24n
		case 'Weeks': return deltaToAdd * 60n * 60n * 24n * 7n
		case 'Months': return deltaToAdd * 60n * 60n * 24n * 30n
		case 'Years': return deltaToAdd * 60n * 60n * 24n * 365n
		default: assertNever(deltaUnit)
	}
}

// Ported from go-ethereum's EIP-1559 base-fee calculation.
export const getNextBaseFeePerGas = (parentGasUsed: bigint, parentGasLimit: bigint, parentBaseFeePerGas: bigint) => {
	const parentGasTarget = parentGasLimit / ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER
	if (parentGasUsed === parentGasTarget) return parentBaseFeePerGas
	if (parentGasUsed > parentGasTarget) return parentBaseFeePerGas + max(1n, parentBaseFeePerGas * (parentGasUsed - parentGasTarget) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
	return max(0n, parentBaseFeePerGas - parentBaseFeePerGas * (parentGasTarget - parentGasUsed) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
}
