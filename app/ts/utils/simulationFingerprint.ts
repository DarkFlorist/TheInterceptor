import { keccak256, toUtf8Bytes } from './viem.js'
import { dataStringWith0xStart, stringifyJSONWithBigInts } from './bigint.js'
import { EthereumSignedTransactionToSignedTransaction, serializeSignedTransactionToBytes } from './ethereum.js'
import { SimulationStateInput } from '../types/visualizer-types.js'

export function getSimulationInputHash(simulationStateInput: SimulationStateInput) {
	const messages = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.signedMessages.map((signedMessage) => ({
		fakeSignedFor: signedMessage.fakeSignedFor,
		originalRequestParameters: signedMessage.originalRequestParameters,
	}))))
	const overrides = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.stateOverrides))
	const transactions = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.transactions.map((transaction) => dataStringWith0xStart(serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(transaction.signedTransaction))))))
	const blockTime = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.blockTimeManipulation))
	const baseFee = stringifyJSONWithBigInts(simulationStateInput.map((x) => x.simulateWithZeroBaseFee))
	return keccak256(toUtf8Bytes(JSON.stringify([messages, overrides, transactions, blockTime, baseFee])))
}
