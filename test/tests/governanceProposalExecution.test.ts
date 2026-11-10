import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { simulateGovernanceProposalExecution } from '../../app/ts/simulation/governanceProposalExecution.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MOCK_ADDRESS } from '../../app/ts/utils/constants.js'
import { createExampleSimulationStack, createReplayingEthereumClientService, EXAMPLE_STACK_SENDER, type GovernanceFixture } from '../governanceFixtures.js'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'

// Each fixture is the RPC conversation of one preview, recorded from a real node by scripts/record-governance-fixtures.mts; its description names the chain state it was recorded on.
const loadFixture = async (name: string): Promise<GovernanceFixture> => await Bun.file(new URL(`../fixtures/governance/${ name }.json`, import.meta.url)).json()

const WEBSITE = { websiteOrigin: 'https://governance.fixture', icon: undefined, title: undefined }
const UNISWAP_TIMELOCK = 0x1a9c8182c09f50c8318d769245bea52c32be35bcn
const COMPOUND_TIMELOCK = 0x6d903f6003cca6255d85cca4d3b5e5146dc33925n
const ENS_TIMELOCK = 0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7n
const TWO_DAYS_IN_SECONDS = 2 * 24 * 60 * 60

const previewFixture = async (name: string, stackSimulationInput: SimulationStateInput = []) => {
	const fixture = await loadFixture(name)
	const { ethereum, requests } = createReplayingEthereumClientService(fixture)
	const preview = await simulateGovernanceProposalExecution(ethereum, stackSimulationInput, BigInt(fixture.governor), BigInt(fixture.proposalId), WEBSITE)
	return { preview, requests, governor: BigInt(fixture.governor) }
}

const simulateRequests = (requests: readonly EthereumJsonRpcRequest[]) => requests.flatMap((request) => request.method === 'eth_simulateV1' ? [request.params[0]] : [])

// Nothing the preview sends may replace code, balances or storage anywhere: the outcome has to come from the chain as it is.
const assertNoStateOverrides = (requests: readonly EthereumJsonRpcRequest[]) => {
	for (const simulation of simulateRequests(requests)) {
		for (const block of simulation.blockStateCalls) assert.deepEqual(Object.keys(block.stateOverrides ?? {}), [])
	}
}

const getExecution = (preview: Awaited<ReturnType<typeof simulateGovernanceProposalExecution>>) => {
	if (!preview.success) throw new Error(`Expected an outcome, got: ${ preview.errorMessage }`)
	const executionBlock = preview.simulationState.simulatedBlocks[0]
	if (executionBlock === undefined || preview.simulationState.simulatedBlocks.length !== 1) throw new Error('Expected exactly the execution block')
	return { ...preview, transactions: executionBlock.simulatedTransactions }
}

const assertRefused = (preview: Awaited<ReturnType<typeof simulateGovernanceProposalExecution>>, reason: RegExp) => {
	if (preview.success) throw new Error('Expected no outcome')
	assert.match(preview.errorMessage, /^No outcome is simulated: /)
	assert.match(preview.errorMessage, reason)
}

describe('governance proposal execution preview of real governors', () => {
	test('simulates a Uniswap GovernorBravo proposal that is being voted on as its timelock queues and executes it', async () => {
		const { preview, requests, governor } = await previewFixture('uniswap-bravo-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, UNISWAP_TIMELOCK)
		// getActions of this proposal needs about 150000 gas, more than the 90000 the reads used to be limited to.
		assert.equal(execution.transactions.length, 3)
		for (const transaction of execution.transactions) {
			assert.equal(transaction.preSimulationTransaction.signedTransaction.from, governor)
			assert.equal(transaction.preSimulationTransaction.signedTransaction.to, UNISWAP_TIMELOCK)
			assert.equal(transaction.ethSimulateV1CallResult.status, 'success')
		}
		const [queueBlock, executionBlock] = simulateRequests(requests).flatMap((simulation) => simulation.blockStateCalls.length === 2 ? [simulation.blockStateCalls] : [])[0] ?? []
		const queueTime = queueBlock?.blockOverrides?.time
		const executionTime = executionBlock?.blockOverrides?.time
		if (queueTime === undefined || executionTime === undefined) throw new Error('Expected a queue block and an execution block')
		assert.equal((executionTime.getTime() - queueTime.getTime()) / 1000, TWO_DAYS_IN_SECONDS)
		assertNoStateOverrides(requests)
	})

	test('executes a queued Uniswap GovernorBravo proposal through the governor exactly as it was executed on chain', async () => {
		const { preview, requests, governor } = await previewFixture('uniswap-bravo-queued')
		const [transaction, ...otherTransactions] = getExecution(preview).transactions
		if (transaction === undefined) throw new Error('Expected the execute transaction')
		assert.equal(otherTransactions.length, 0)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.from, MOCK_ADDRESS)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.to, governor)
		if (transaction.ethSimulateV1CallResult.status !== 'success') throw new Error('Expected the execution to succeed')
		// The proposal's real execution, 0xc3b82a4721717315ce420f5c5f422934e4f662f170da7bb70cc5aad337a34dc4, used 402330 gas and emitted 9 logs.
		assert.equal(transaction.ethSimulateV1CallResult.gasUsed, 402330n)
		assert.equal(transaction.ethSimulateV1CallResult.logs.length, 9)
		assertNoStateOverrides(requests)
	})

	test('runs an action that calls the Compound Timelock itself on the real timelock', async () => {
		const { preview, requests } = await previewFixture('compound-bravo-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, COMPOUND_TIMELOCK)
		// Proposal 393 calls setPendingAdmin on the timelock itself, which the timelock code that used to replace it did not have.
		assert.deepEqual(execution.transactions.map((transaction) => transaction.ethSimulateV1CallResult.status), ['success', 'success', 'success'])
		assertNoStateOverrides(requests)
	})

	test('finds the actions of an OpenZeppelin governor in its ProposalCreated event and executes them through its TimelockController', async () => {
		const { preview, requests, governor } = await previewFixture('ens-governor-active')
		const [transaction, ...otherTransactions] = getExecution(preview).transactions
		if (transaction === undefined) throw new Error('Expected the executeBatch transaction')
		assert.equal(otherTransactions.length, 0)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.from, governor)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.to, ENS_TIMELOCK)
		assert.equal(transaction.ethSimulateV1CallResult.status, 'success')
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 1)
		assertNoStateOverrides(requests)
	})

	test('executes the actions of an OpenZeppelin governor with GovernorStorage through its Compound Timelock', async () => {
		const { preview, requests, governor } = await previewFixture('compound-governor-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, COMPOUND_TIMELOCK)
		assert.equal(execution.transactions.length, 2)
		for (const transaction of execution.transactions) {
			assert.equal(transaction.preSimulationTransaction.signedTransaction.from, governor)
			assert.equal(transaction.ethSimulateV1CallResult.status, 'success')
		}
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 0)
		assertNoStateOverrides(requests)
	})

	test('simulates the proposal after the simulation stack and queues it no earlier than a minute after the stack', async () => {
		const { preview, requests } = await previewFixture('ens-governor-succeeded-after-stack', createExampleSimulationStack())
		const execution = getExecution(preview)
		assert.equal(execution.timelock, ENS_TIMELOCK)
		// The outcome holds only the execution block, not the stack or the queue block before it.
		assert.equal(execution.simulationState.simulationStateInput.length, 1)
		const executionSimulation = simulateRequests(requests).find((simulation) => simulation.blockStateCalls.length === 3)
		if (executionSimulation === undefined) throw new Error('Expected the stack, queue and execution blocks in one simulation')
		const [stackBlock, queueBlock, executionBlock] = executionSimulation.blockStateCalls
		assert.equal(stackBlock?.calls[0]?.from, EXAMPLE_STACK_SENDER)
		const stackTime = stackBlock?.blockOverrides?.time?.getTime()
		const queueTime = queueBlock?.blockOverrides?.time?.getTime()
		const executionTime = executionBlock?.blockOverrides?.time?.getTime()
		if (stackTime === undefined || queueTime === undefined || executionTime === undefined) throw new Error('Expected block times')
		// Voting on this proposal has ended, so it is queued as soon as the preview allows and executed after the timelock's minimum delay of two days.
		assert.equal((queueTime - stackTime) / 1000, 60)
		assert.equal((executionTime - queueTime) / 1000, TWO_DAYS_IN_SECONDS)
		assertNoStateOverrides(requests)
	})

	test('shows no outcome for a proposal that was already executed', async () => {
		const { preview } = await previewFixture('uniswap-bravo-executed')
		assertRefused(preview, /proposal 102 is executed, so it will not be executed/)
	})
})

describe('governance proposal execution preview of contracts built to look like a governor', () => {
	const refusedBeforeExecution = [
		['abuse-weth-as-timelock', /0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, which .* names as its timelock, is neither a Compound Timelock nor an OpenZeppelin TimelockController/],
		['abuse-eeee-as-timelock', /0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, which .* names as its timelock, is neither a Compound Timelock nor an OpenZeppelin TimelockController/],
		['abuse-uniswap-timelock-named', /0x1a9C8182C09F50C8318d769245beA52c32BE35BC, which .* is a Compound Timelock whose admin is 0x408ED6354d4973f66138C91495F2f2FCbd8724C3/],
		['abuse-ens-timelock-named', /0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7, which .* is a TimelockController that does not give this governor the proposer role/],
	] as const
	for (const [name, reason] of refusedBeforeExecution) {
		test(`${ name }: refuses before running anything as the named timelock`, async () => {
			const { preview, requests, governor } = await previewFixture(name)
			assertRefused(preview, reason)
			// Only the two batches of reads ran, and no call came from the governor.
			const simulations = simulateRequests(requests)
			assert.equal(simulations.length, 2)
			for (const simulation of simulations) {
				for (const block of simulation.blockStateCalls) assert.ok(block.calls.every((call) => call.from === MOCK_ADDRESS && call.from !== governor))
			}
			assertNoStateOverrides(requests)
		})
	}

	test('refuses a queued proposal whose governor pays out from execute instead of executing through its timelock', async () => {
		const { preview, requests } = await previewFixture('abuse-queued-execute-pays-out')
		assertRefused(preview, /executing proposal 1 did not make 0x5c4075FCC531b2227dd1E6Aef747BeEe3a0A7067 execute its actions/)
		assertNoStateOverrides(requests)
	})

	test('refuses a timelock that answers like a Compound Timelock but executes nothing', async () => {
		const { preview, requests } = await previewFixture('abuse-timelock-executes-nothing')
		assertRefused(preview, /executing proposal 1 did not make 0x7f08904bdF69bE49734b0D2039A5f830CeFc2EC9 execute its actions/)
		assertNoStateOverrides(requests)
	})

	test('a governor with a timelock of its own can only move what that timelock holds', async () => {
		const { preview, requests } = await previewFixture('abuse-own-funded-timelock')
		const execution = getExecution(preview)
		const ownTimelock = 0xef0f70eb6aaa500dcbdac11a2fb2591892051b39n
		assert.equal(execution.timelock, ownTimelock)
		const [transaction] = execution.transactions
		if (transaction?.ethSimulateV1CallResult.status !== 'success') throw new Error('Expected the execution to succeed')
		// The node reports the 1000 ether it sends as a transfer log; its sender is the attacker's own timelock.
		const etherTransfers = transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
		assert.equal(etherTransfers.length, 1)
		assert.equal(etherTransfers[0]?.topics[1], ownTimelock)
		assertNoStateOverrides(requests)
	})
})
