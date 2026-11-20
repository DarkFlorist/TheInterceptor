import type { Settings } from '../types/interceptor-messages.js'
import type { RichModeState } from '../types/richMode.js'
import type { BlockTimeManipulation, InterceptorTransactionStack, PreSimulationTransaction, SignedMessageTransaction, SimulationStateInput, SimulationStateInputBlock } from '../types/visualizer-types.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import { getActiveStackContext, getOperationsForActiveStackContext } from '../utils/activeStackContext.js'
import { addRichAccountBalanceOverrides } from '../utils/richTokens.js'
import { assertNever } from '../utils/typescript.js'
import { profilesForAddresses, richTokensForPresentation } from './richModeSettings.js'

const getMakeCurrentAddressRichStateOverride = (chainId: bigint, addressesToMakeRich: readonly bigint[], state: RichModeState) => {
	if (addressesToMakeRich.length === 0) return {}
	const profiles = profilesForAddresses(state, chainId, addressesToMakeRich)
	return addRichAccountBalanceOverrides({}, profiles.filter((profile) => profile.chainId === chainId && addressesToMakeRich.includes(profile.address)), richTokensForPresentation(state))
}

// Storage state besides the settings and the stack that simulation input is built from.
type SimulationInputSources = {
	readonly richAddresses: readonly bigint[]
	readonly richModeState: RichModeState
	readonly preSimulationBlockTimeManipulation: BlockTimeManipulation
}

// Builds the input without reading storage, so callers decide when every source was read.
export function buildSimulationStateInput(settings: Settings, sources: SimulationInputSources, stack: InterceptorTransactionStack): SimulationStateInput {
	const inputBlocks: SimulationStateInputBlock[] = []
	let currentBlockTransactions: PreSimulationTransaction[] = []
	let currentBlockSignedMessages: SignedMessageTransaction[] = []
	let currentBlockStateOverrides = getMakeCurrentAddressRichStateOverride(settings.activeRpcNetwork.chainId, sources.richAddresses, sources.richModeState)
	let previousBlockTimeManipulation = settings.simulationMode ? sources.preSimulationBlockTimeManipulation : DEFAULT_BLOCK_MANIPULATION

	const pushBlock = (blockTimeManipulation: BlockTimeManipulation) => {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: false,
		})
		previousBlockTimeManipulation = blockTimeManipulation
		currentBlockSignedMessages = []
		currentBlockStateOverrides = {}
		currentBlockTransactions = []
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
			simulateWithZeroBaseFee: false,
		})
	}
	return inputBlocks
}
