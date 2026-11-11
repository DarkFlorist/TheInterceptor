// Records the RPC exchanges of one governance execution preview into test/fixtures/governance/<name>.json for test/tests/governanceProposalExecution.test.ts to replay. Usage: bun ./scripts/record-governance-fixtures.mts <name> <rpcUrl> <governor> <proposalId> <description> [--stack=<name of an EXAMPLE_STACKS entry in test/governanceFixtures.ts>]. The safeExecution stack needs the Safe that test/governanceFixtures.ts names as EXAMPLE_SAFE deployed and funded on the node first. Proposals in a past state were recorded on an anvil fork of mainnet at the block their description names (anvil --fork-url <archive RPC> --fork-block-number <block>).
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { simulateGovernanceProposalExecution } from '../app/ts/simulation/governanceProposalExecution.js'
import { EthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EXAMPLE_STACKS, createRecordingEthereumClientService, isExampleStackName, pinToLatestBlock, prepareExampleStack, type GovernanceFixture } from '../test/governanceFixtures.js'
import { SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../app/ts/safe/safeExecutionSimulation.js'
import { addressString } from '../app/ts/utils/bigint.js'

const [name, rpcUrl, governor, proposalId, description, stackOption] = process.argv.slice(2)
if (name === undefined || rpcUrl === undefined || governor === undefined || proposalId === undefined || description === undefined) throw new Error('Usage: bun ./scripts/record-governance-fixtures.mts <name> <rpcUrl> <governor> <proposalId> <description>')

const stackName = stackOption?.replace('--stack=', '')
if (stackName !== undefined && !isExampleStackName(stackName)) throw new Error(`Unknown stack ${ stackName }`)
const { ethereum, exchanges } = createRecordingEthereumClientService(new EthereumJSONRpcRequestHandler(rpcUrl))
const pinnedEthereum = await pinToLatestBlock(ethereum)
const preview = await simulateGovernanceProposalExecution(pinnedEthereum, await prepareExampleStack(pinnedEthereum, stackName === undefined ? [] : EXAMPLE_STACKS[stackName]()), BigInt(governor), BigInt(proposalId), { websiteOrigin: 'https://governance.fixture', icon: undefined, title: undefined })
console.log(preview.success ? `${ name }: simulated ${ preview.simulationState.simulatedBlocks[0]?.simulatedTransactions.length ?? 0 } execution transactions` : `${ name }: ${ preview.errorMessage }`)

const fixture: GovernanceFixture = { description, governor, proposalId, ...stackName === undefined ? {} : { stack: stackName }, ...stackName === 'safeExecution' ? { safeExecutionExecutor: addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR) } : {}, exchanges: exchanges() }
const fixturePath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'governance', `${ name }.json`)
await fs.mkdir(path.dirname(fixturePath), { recursive: true })
await fs.writeFile(fixturePath, `${ JSON.stringify(fixture) }\n`)
