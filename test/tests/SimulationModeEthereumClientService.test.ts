import { beforeEach, describe, test } from 'bun:test'
import * as assert from 'assert'
import { createSimulationState, getSimulatedBlock, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { createSimulationModeTestContext } from './simulationModeEthereumClientServiceTestHelpers.js'

const { ethereum, reset } = createSimulationModeTestContext()
beforeEach(reset)

describe('SimulationModeEthereumClientService', () => {
	const exampleTransaction = {
		type: '1559',
		from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 21000n,
		to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
		value: 10n,
		input: new Uint8Array(0),
		chainId: 1n,
	} as const

	const createSimulationStateInput = () => [{
		stateOverrides: {},
		transactions: [{
			signedTransaction: mockSignTransaction({
				...exampleTransaction,
				nonce: 0n,
			}),
			website: { websiteOrigin: 'test', icon: undefined, title: undefined },
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
			transactionIdentifier: 100n,
		}],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	}] as const

			test('state-based full blocks include transaction block data and realized gas price', async () => {
				const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const latestBlock = await getSimulatedBlock(ethereum, undefined, toResolvedSimulationState(simulationState), 'latest', true)
				if (latestBlock === null) throw new Error('latest simulated block missing')
				const transaction = latestBlock.transactions[0]
				if (transaction === undefined || !('blockHash' in transaction)) throw new Error('full simulated transaction data missing')

				assert.equal(transaction.blockHash, latestBlock.hash)
				assert.equal(transaction.blockNumber, latestBlock.number)
				assert.equal(transaction.transactionIndex, 0n)
				assert.deepEqual(transaction.data, transaction.input)
				assert.equal(transaction.gasPrice, simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.realizedGasPrice)
			})

		})
