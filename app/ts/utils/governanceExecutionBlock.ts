import { checksummedAddress } from './bigint.js'
import { MOCK_ADDRESS } from './constants.js'

const SECONDS_PER_BLOCK = 12n

/**
 * The governance preview sets only the time of the block it executes a proposal in: go-ethereum's eth_simulateV1 runs at most 256 blocks past its base, gaps included, while a proposal executes tens of thousands of blocks later. So the simulated block keeps a number just after the parent's, and this says so, with the number the real execution would have at 12 seconds a block. Undefined when the simulated number is not behind.
 */
export const describeGovernanceExecutionBlockNumber = (parentBlock: { readonly number: bigint, readonly timestamp: Date }, simulatedExecutionBlockNumber: bigint | undefined, executionTime: bigint) => {
	if (simulatedExecutionBlockNumber === undefined) return undefined
	const parentTime = BigInt(Math.floor(parentBlock.timestamp.getTime() / 1000))
	const estimatedExecutionBlockNumber = parentBlock.number + (executionTime > parentTime ? (executionTime - parentTime) / SECONDS_PER_BLOCK : 0n)
	if (estimatedExecutionBlockNumber <= simulatedExecutionBlockNumber) return undefined
	return `The simulation runs it at block ${ simulatedExecutionBlockNumber }, not at about block ${ estimatedExecutionBlockNumber } as on chain, because nodes simulate at most 256 blocks ahead. An action that depends on the block number can differ.`
}

// The preview's own blocks run with a base fee of 0 and send every planned call from MOCK_ADDRESS (governanceProposalExecution.ts), so block.basefee and tx.origin differ from the real execution. A proposal can branch on either to look harmless here, so the panel says so with every outcome.
export const GOVERNANCE_EXECUTION_ENVIRONMENT_NOTE = `The simulation runs the execution with a base fee of 0 and sends it from ${ checksummedAddress(MOCK_ADDRESS) }, while on chain the block has a base fee and whoever executes the proposal sends it. An action that depends on block.basefee or tx.origin can behave differently on chain, and a proposal can use that to look harmless here.`
