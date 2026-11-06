import type { SignedMessageTransaction, SimulationStateInput, VisualizedSimulationState } from '../../types/visualizer-types.js'
import type { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import type { PreSimulationTransaction, NonSimulatedAndVisualizedTransaction, SimulatedAndVisualizedTransaction } from '../../types/visualizer-types.js'
import { getSignatureVerdict, getTransactionVerdict, type SimulationVerdict } from '../../utils/simulationVerdict.js'

export type SimulationStackTransactionRow = {
	type: 'Transaction'
	blockIndex: number
	transactionIndex: number
	status: 'pending' | 'simulated' | 'failed'
	preSimulationTransaction: PreSimulationTransaction
	simulatedTransaction: SimulatedAndVisualizedTransaction | NonSimulatedAndVisualizedTransaction | undefined
}

export type SimulationStackMessageRow = {
	type: 'Message'
	blockIndex: number
	messageIndex: number
	status: 'pending' | 'simulated'
	signedMessageTransaction: SignedMessageTransaction
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest | undefined
}

export type SimulationStackBlock = {
	blockIndex: number
	blockTimeManipulation: SimulationStateInput[number]['blockTimeManipulation']
	rows: readonly (SimulationStackTransactionRow | SimulationStackMessageRow)[]
}

export function normalizeSimulationStackRows(simulationStateInput: SimulationStateInput, visualizedSimulationState: VisualizedSimulationState): readonly SimulationStackBlock[] {
	return simulationStateInput.map((inputBlock, blockIndex) => {
		const visualizedBlock = visualizedSimulationState.visualizedBlocks[blockIndex]
		let transactionIndex = 0
		let messageIndex = 0
		const rows: (SimulationStackTransactionRow | SimulationStackMessageRow)[] = []

		for (const signedMessageTransaction of inputBlock.signedMessages) {
			const visualizedPersonalSignRequest = visualizedBlock?.visualizedPersonalSignRequests[messageIndex]
			rows.push({
				type: 'Message',
				blockIndex,
				messageIndex,
				status: visualizedPersonalSignRequest === undefined ? 'pending' : 'simulated',
				signedMessageTransaction,
				visualizedPersonalSignRequest,
			})
			messageIndex += 1
		}

		for (const preSimulationTransaction of inputBlock.transactions) {
			const simulatedTransaction = visualizedBlock?.simulatedAndVisualizedTransactions[transactionIndex]
			rows.push({
				type: 'Transaction',
				blockIndex,
				transactionIndex,
				status: simulatedTransaction === undefined ? 'pending' : simulatedTransaction.transactionStatus === 'Failed To Simulate' ? 'failed' : 'simulated',
				preSimulationTransaction,
				simulatedTransaction,
			})
			transactionIndex += 1
		}

		return {
			blockIndex,
			blockTimeManipulation: inputBlock.blockTimeManipulation,
			rows,
		}
	})
}

export type SimulationStackRowStatus = 'success' | 'warning' | 'failed' | 'pending'

const rowStatusOfVerdict = { succeeded: 'success', flagged: 'warning', failed: 'failed' } as const satisfies Record<SimulationVerdict, SimulationStackRowStatus>

// The single status a stack row is summarised with: failures outrank warnings, and anything not simulated yet is pending.
export function getSimulationStackRowStatus(stackRow: SimulationStackTransactionRow | SimulationStackMessageRow): SimulationStackRowStatus {
	if (stackRow.type === 'Message') {
		if (stackRow.status !== 'simulated' || stackRow.visualizedPersonalSignRequest === undefined) return 'pending'
		return rowStatusOfVerdict[getSignatureVerdict(stackRow.visualizedPersonalSignRequest)]
	}
	if (stackRow.status === 'failed') return 'failed'
	if (stackRow.status !== 'simulated' || stackRow.simulatedTransaction === undefined) return 'pending'
	return rowStatusOfVerdict[getTransactionVerdict(stackRow.simulatedTransaction)]
}
