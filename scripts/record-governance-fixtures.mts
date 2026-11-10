// Records the RPC exchanges of one governance execution preview into test/fixtures/governance/<name>.json for test/tests/governanceProposalExecution.test.ts to replay. Usage: bun ./scripts/record-governance-fixtures.mts <name> <rpcUrl> <governor> <proposalId> <description> [--after-example-stack]. Proposals in a past state were recorded on an anvil fork of mainnet at the block their description names (anvil --fork-url <archive RPC> --fork-block-number <block>).
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { simulateGovernanceProposalExecution } from '../app/ts/simulation/governanceProposalExecution.js'
import { EthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { createExampleSimulationStack, createRecordingEthereumClientService, type GovernanceFixture } from '../test/governanceFixtures.js'

const [name, rpcUrl, governor, proposalId, description, stackOption] = process.argv.slice(2)
if (name === undefined || rpcUrl === undefined || governor === undefined || proposalId === undefined || description === undefined) throw new Error('Usage: bun ./scripts/record-governance-fixtures.mts <name> <rpcUrl> <governor> <proposalId> <description>')

const { ethereum, exchanges } = createRecordingEthereumClientService(new EthereumJSONRpcRequestHandler(rpcUrl))
const preview = await simulateGovernanceProposalExecution(ethereum, stackOption === '--after-example-stack' ? createExampleSimulationStack() : [], BigInt(governor), BigInt(proposalId), { websiteOrigin: 'https://governance.fixture', icon: undefined, title: undefined })
console.log(preview.success ? `${ name }: simulated ${ preview.simulationState.simulatedBlocks[0]?.simulatedTransactions.length ?? 0 } execution transactions` : `${ name }: ${ preview.errorMessage }`)

const fixture: GovernanceFixture = { description, governor, proposalId, exchanges: exchanges() }
const fixturePath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'governance', `${ name }.json`)
await fs.mkdir(path.dirname(fixturePath), { recursive: true })
await fs.writeFile(fixturePath, `${ JSON.stringify(fixture) }\n`)
