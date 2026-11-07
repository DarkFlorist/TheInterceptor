import type { Settings } from '../types/interceptor-messages.js'
import type { BlockTimeManipulation, InterceptorTransactionStack, PreSimulationTransaction, SignedMessageTransaction, SimulationStateInput, SimulationStateInputBlock } from '../types/visualizer-types.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import { getAddressToMakeRich } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getActiveStackContext, getOperationsForActiveStackContext } from '../utils/activeStackContext.js'
import { addressString } from '../utils/bigint.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { assertNever } from '../utils/typescript.js'
import { getFixedAddressRichList, getPreSimulationBlockTimeManipulation } from './settings.js'

// Below the network transition lock, which builds every snapshot from these, so that simulationUpdating.ts can import the lock.

const getMakeCurrentAddressRichStateOverride = (addressesToMakeRich: readonly bigint[]) => {
	if (addressesToMakeRich.length === 0) return {}
	return Object.fromEntries(
		addressesToMakeRich.map(currentAddress => {
			const addressKey = addressString(currentAddress)
			return [addressKey, { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		})
	)
}

const getRichAddresses = async (settings: Settings, activeAddressMadeRich: bigint | undefined) => {
	if (!settings.simulationMode) return []
	const makeRichAddressList = await getFixedAddressRichList()
	return [...makeRichAddressList.filter((x) => x.makingRich).map((x) => x.address), ...activeAddressMadeRich === undefined ? [] : [activeAddressMadeRich]]
}

// Storage state besides the settings and the stack that simulation input is built from.
type SimulationInputSources = {
	readonly richAddresses: readonly bigint[]
	readonly preSimulationBlockTimeManipulation: BlockTimeManipulation
}

// A snapshot also records which of the rich addresses is the active one.
export type SimulationSnapshotSources = SimulationInputSources & { readonly activeAddressMadeRich: bigint | undefined }

export async function readSimulationInputSources(settings: Settings): Promise<SimulationSnapshotSources> {
	const [activeAddressMadeRich, preSimulationBlockTimeManipulation] = await Promise.all([getAddressToMakeRich(settings), getPreSimulationBlockTimeManipulation()])
	return { richAddresses: await getRichAddresses(settings, activeAddressMadeRich), activeAddressMadeRich, preSimulationBlockTimeManipulation }
}

// Builds the input without reading storage, so callers decide when every source was read.
export function buildSimulationStateInput(settings: Settings, sources: SimulationInputSources, stack: InterceptorTransactionStack): SimulationStateInput {
	const inputBlocks: SimulationStateInputBlock[] = []
	let currentBlockTransactions: PreSimulationTransaction[] = []
	let currentBlockSignedMessages: SignedMessageTransaction[] = []
	let currentBlockStateOverrides = getMakeCurrentAddressRichStateOverride(sources.richAddresses)
	let previousBlockTimeManipulation = settings.simulationMode ? sources.preSimulationBlockTimeManipulation : DEFAULT_BLOCK_MANIPULATION
	let currentBlockSimulateWithZeroBaseFee = false

	const pushBlock = (blockTimeManipulation: BlockTimeManipulation) => {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: currentBlockSimulateWithZeroBaseFee,
		})
		previousBlockTimeManipulation = blockTimeManipulation
		currentBlockSignedMessages = []
		currentBlockStateOverrides = {}
		currentBlockTransactions = []
		currentBlockSimulateWithZeroBaseFee = false
	}

	const operations = getOperationsForActiveStackContext(stack, getActiveStackContext(settings))
	for (const operation of operations) {
		switch(operation.type) {
			case 'Transaction': {
				const simulationOptions = operation.preSimulationTransaction.simulationOptions
				if (
					simulationOptions?.requiredChainId !== undefined
					&& simulationOptions.requiredChainId !== settings.activeRpcNetwork.chainId
				) break
				const simulateWithZeroBaseFee = simulationOptions?.simulateWithZeroBaseFee ?? false
				if (currentBlockTransactions.length > 0 && currentBlockSimulateWithZeroBaseFee !== simulateWithZeroBaseFee) {
					pushBlock({ type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' })
				}
				currentBlockSimulateWithZeroBaseFee = simulateWithZeroBaseFee
				currentBlockTransactions.push(operation.preSimulationTransaction)
				break
			}
			case 'Message': {
				if (currentBlockTransactions.length > 0) {
					pushBlock({ type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' })
				}
				currentBlockSignedMessages.push(operation.signedMessageTransaction)
				break
			}
			case 'TimeManipulation': {
				pushBlock(operation.blockTimeManipulation)
				break
			}
			default: assertNever(operation)
		}
	}
	if (
		currentBlockTransactions.length > 0
		|| currentBlockSignedMessages.length > 0
		|| Object.keys(currentBlockStateOverrides).length > 0
	) {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: currentBlockSimulateWithZeroBaseFee,
		})
	}
	return inputBlocks
}
