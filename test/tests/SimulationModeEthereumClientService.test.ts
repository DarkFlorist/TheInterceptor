import { beforeEach, describe, test } from 'bun:test'
import * as assert from 'assert'
import { createSimulationState, getSimulatedBlock } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { createSimulationModeTestContext, createSimulationStateInput } from './simulationModeEthereumClientServiceTestHelpers.js'

const { ethereum, reset } = createSimulationModeTestContext()
beforeEach(reset)

describe('SimulationModeEthereumClientService', () => {

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
