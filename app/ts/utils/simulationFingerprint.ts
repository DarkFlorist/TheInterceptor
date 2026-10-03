import { stringToBytes, keccak256 } from './ethereumPrimitives.js'
import { dataStringWith0xStart, stringifyJSONWithBigInts } from './bigint.js'
import { EthereumSignedTransactionToSignedTransaction, serializeSignedTransactionToBytes } from './ethereum.js'
import type { SimulationStateInput, SimulationStateInputMinimalData } from '../types/visualizer-types.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'

export function getSimulationInputHash(simulationStateInput: SimulationStateInput | SimulationStateInputMinimalData, simulationOverrides: StateOverrides = {}) {
	const messages = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.signedMessages.map((signedMessage) => ({
		fakeSignedFor: signedMessage.fakeSignedFor,
		originalRequestParameters: signedMessage.originalRequestParameters,
	}))))
	const overrides = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.stateOverrides))
	const overridesForEveryBlock = stringifyJSONWithBigInts(simulationOverrides)
	const transactions = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.transactions.map((transaction) => dataStringWith0xStart(serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(transaction.signedTransaction))))))
	const blockTime = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.blockTimeManipulation))
	const baseFee = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.simulateWithZeroBaseFee))
	return keccak256(stringToBytes(JSON.stringify([messages, overrides, overridesForEveryBlock, transactions, blockTime, baseFee])))
}
