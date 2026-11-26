import type { BlockOverrides } from '../../types/ethSimulate-types.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../config/defaults.js'
import type { BlockTimeManipulation, BlockTimeManipulationDeltaUnit } from '../../types/visualizer-types.js'
import type { EthereumBlockHeader, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { bigintSecondsToDate, dateToBigintSeconds, max, min } from '../../utils/bigint.js'
import { ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER } from '../../utils/constants.js'
import { assertNever } from '../../utils/typescript.js'

export const calculateRealizedEffectiveGasPrice = (transaction: EthereumUnsignedTransaction, blocksBaseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) return transaction.gasPrice
	return min(blocksBaseFeePerGas + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

// The base fee of every block a simulation adds on top of the parent block: the parent's, or a fallback for a chain whose blocks have none. A Gnosis Safe execution's executor pays it (prepareGnosisSafeExecutionSimulationInput).
export const getSimulatedBlockBaseFeePerGas = (parentBlock: { readonly baseFeePerGas?: bigint | undefined }) => parentBlock.baseFeePerGas ?? 15_000_000n

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

export const getNextBlockTimeStampOverride = (previousBlockTimeStamp: Date, blockTimeManipulation: BlockTimeManipulation) => {
	const prevTime = dateToBigintSeconds(previousBlockTimeStamp)
	// Nodes reject an eth_simulateV1 block that is not strictly later than its parent, so a zero delay (a block split inserted by getCurrentSimulationInput, or a user's 0) still advances the simulated time by one second.
	if (blockTimeManipulation.type === 'AddToTimestamp') return bigintSecondsToDate(prevTime + max(1n, getBlockTimeManipulationSeconds(blockTimeManipulation.deltaToAdd, blockTimeManipulation.deltaUnit)))
	return bigintSecondsToDate(max(prevTime + 1n, blockTimeManipulation.timeToSet))
}

// Every appended inspection/call block shares these inherited overrides, base-fee policy and timestamp advancement; the code probe supplies only its own calls and state overrides.
export const getAppendedSimulationBlockOverrides = (parentBlock: Pick<NonNullable<EthereumBlockHeader>, 'miner' | 'timestamp' | 'baseFeePerGas'>, previousBlockOverride: BlockOverrides | undefined, simulateWithZeroBaseFee = false): BlockOverrides => ({
	...(previousBlockOverride ?? { feeRecipient: parentBlock.miner }),
	baseFeePerGas: simulateWithZeroBaseFee ? 0n : getSimulatedBlockBaseFeePerGas(parentBlock),
	time: getNextBlockTimeStampOverride(previousBlockOverride?.time ?? parentBlock.timestamp, DEFAULT_BLOCK_MANIPULATION),
})
