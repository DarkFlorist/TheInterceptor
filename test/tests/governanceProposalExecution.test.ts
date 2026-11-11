import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { gasLimitsByNeed, getProposalCreatedSearchRange, getTransactionGasLimit, MAXIMUM_BLOCKS_PER_LOG_QUERY, PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS, simulateGovernanceProposalExecution, splitIntoLogQueries } from '../../app/ts/simulation/governanceProposalExecution.js'
import { SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../../app/ts/safe/safeExecutionSimulation.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MOCK_ADDRESS } from '../../app/ts/utils/constants.js'
import { createReplayingEthereumClientService, EXAMPLE_SAFE, EXAMPLE_STACK_SENDER, EXAMPLE_STACKS, type GovernanceFixture, isExampleStackName, prepareExampleStack } from '../governanceFixtures.js'

// Each fixture is the RPC conversation of one preview, recorded from a real node by scripts/record-governance-fixtures.mts; its description names the chain state it was recorded on.
const loadFixture = async (name: string): Promise<GovernanceFixture> => await Bun.file(new URL(`../fixtures/governance/${ name }.json`, import.meta.url)).json()

const WEBSITE = { websiteOrigin: 'https://governance.fixture', icon: undefined, title: undefined }
const UNISWAP_TIMELOCK = 0x1a9c8182c09f50c8318d769245bea52c32be35bcn
const COMPOUND_TIMELOCK = 0x6d903f6003cca6255d85cca4d3b5e5146dc33925n
const ENS_TIMELOCK = 0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7n
const TWO_DAYS_IN_SECONDS = 2 * 24 * 60 * 60

const simulateRequests = (requests: readonly EthereumJsonRpcRequest[]) => requests.flatMap((request) => request.method === 'eth_simulateV1' ? [request.params[0]] : [])
const hasOverrides = (stateOverrides: object | undefined) => Object.keys(stateOverrides ?? {}).length > 0

/**
 * The preview's override rule: the governor and the proposal never choose a state override. The only overrides any request may carry are those the user's simulation stack gets from its own preparation, at the stack's own block positions, and every block after the stack carries none.
 */
const assertOnlyStackOverrides = async (ethereum: EthereumClientService, requests: readonly EthereumJsonRpcRequest[], stack: SimulationStateInput) => {
	const getStackOverrides = async () => {
		if (stack.length === 0) return []
		const latestBlock = await ethereum.getBlock(undefined)
		if (latestBlock === null) throw new Error('Expected the latest block')
		return (await ethereum.ethSimulateV1Input(stack, latestBlock.number, undefined)).params[0].blockStateCalls.map((block) => block.stateOverrides ?? {})
	}
	const stackOverrides = await getStackOverrides()
	for (const simulation of simulateRequests(requests)) {
		for (const [blockIndex, block] of simulation.blockStateCalls.entries()) {
			if (!hasOverrides(block.stateOverrides)) continue
			assert.ok(blockIndex < stackOverrides.length, `block ${ blockIndex }, after the stack, carries state overrides`)
			assert.deepStrictEqual(block.stateOverrides, stackOverrides[blockIndex])
		}
	}
	// The stack's own overrides are kept: the execution runs on top of them.
	if (stackOverrides.some(hasOverrides)) assert.ok(simulateRequests(requests).some((simulation) => simulation.blockStateCalls.some((block, blockIndex) => hasOverrides(block.stateOverrides) && blockIndex < stackOverrides.length)))
}

// A governor names the blocks of its ProposalCreated search, so every search has to stay within two requests of at most MAXIMUM_BLOCKS_PER_LOG_QUERY blocks.
const assertBoundedLogSearch = (requests: readonly EthereumJsonRpcRequest[]) => {
	const logQueries = requests.flatMap((request) => request.method === 'eth_getLogs' ? [request.params[0]] : [])
	assert.ok(logQueries.length <= 2)
	for (const query of logQueries) {
		if (typeof query.fromBlock !== 'bigint' || typeof query.toBlock !== 'bigint') throw new Error('Expected a block range')
		assert.ok(query.toBlock - query.fromBlock + 1n <= MAXIMUM_BLOCKS_PER_LOG_QUERY)
	}
}

// The final simulation runs the execution calls together in the last block, sharing its number and timestamp.
const assertExecutedInOneBlock = (requests: readonly EthereumJsonRpcRequest[], callCount: number) => {
	const outcomeSimulation = simulateRequests(requests).find((simulation) => simulation.blockStateCalls.length === 2 && simulation.blockStateCalls[1]?.calls.length === callCount)
	assert.ok(outcomeSimulation !== undefined, `Expected one simulation with all ${ callCount } execution calls in its last block`)
}

const recordedGasLimit = (fixture: GovernanceFixture) => {
	const latestBlock = fixture.exchanges.find((exchange) => JSON.stringify(exchange.request).includes('"latest"'))?.result
	if (typeof latestBlock !== 'object' || latestBlock === null || !('gasLimit' in latestBlock) || typeof latestBlock.gasLimit !== 'string') throw new Error('Expected the recorded block gas limit')
	return BigInt(latestBlock.gasLimit)
}

// Replays a fixture through the preview, after the example stack it was recorded with, and checks the override rule and the log search bound on every request it sent.
const previewFixture = async (name: string) => {
	const fixture = await loadFixture(name)
	if (fixture.stack !== undefined && !isExampleStackName(fixture.stack)) throw new Error(`Unknown stack ${ fixture.stack }`)
	const { ethereum, requests, resultOf } = createReplayingEthereumClientService(fixture)
	const stack = await prepareExampleStack(ethereum, fixture.stack === undefined ? [] : EXAMPLE_STACKS[fixture.stack]())
	const preview = await simulateGovernanceProposalExecution(ethereum, stack, BigInt(fixture.governor), BigInt(fixture.proposalId), WEBSITE)
	await assertOnlyStackOverrides(ethereum, requests, stack)
	assertBoundedLogSearch(requests)
	return { preview, requests, resultOf, stack, governor: BigInt(fixture.governor) }
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
		// Compound's Timelock executes each action in its own call; the outcome runs all three in one block after the queue block.
		const [queueBlock, executionBlock] = simulateRequests(requests).find((simulation) => simulation.blockStateCalls.length === 2 && simulation.blockStateCalls[1]?.calls.length === 3)?.blockStateCalls ?? []
		const queueTime = queueBlock?.blockOverrides?.time
		const executionTime = executionBlock?.blockOverrides?.time
		if (queueTime === undefined || executionTime === undefined) throw new Error('Expected a queue block and an execution block')
		assert.equal((executionTime.getTime() - queueTime.getTime()) / 1000, TWO_DAYS_IN_SECONDS)
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
	})

	test('runs an action that calls the Compound Timelock itself on the real timelock', async () => {
		const { preview, requests } = await previewFixture('compound-bravo-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, COMPOUND_TIMELOCK)
		// Proposal 393 calls setPendingAdmin on the timelock itself, which the timelock code that used to replace it did not have.
		assert.deepEqual(execution.transactions.map((transaction) => transaction.ethSimulateV1CallResult.status), ['success', 'success', 'success'])
	})

	test('finds the actions of an OpenZeppelin governor in its ProposalCreated event and executes them through its TimelockController', async () => {
		const { preview, requests, governor } = await previewFixture('ens-governor-active')
		const [transaction, ...otherTransactions] = getExecution(preview).transactions
		if (transaction === undefined) throw new Error('Expected the executeBatch transaction')
		assert.equal(otherTransactions.length, 0)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.from, governor)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.to, ENS_TIMELOCK)
		assert.equal(transaction.ethSimulateV1CallResult.status, 'success')
		// The search covers a day of blocks either side of the proposal's creation, in two requests.
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 2)
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
	})

	test('simulates the proposal after the simulation stack and queues it no earlier than a minute after the stack', async () => {
		const { preview, requests } = await previewFixture('ens-governor-succeeded-after-stack')
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
			})
	}

	test('refuses a queued proposal whose governor pays out from execute instead of executing through its timelock', async () => {
		const { preview, requests } = await previewFixture('abuse-queued-execute-pays-out')
		assertRefused(preview, /executing proposal 1 did not make 0x5c4075FCC531b2227dd1E6Aef747BeEe3a0A7067 execute its actions/)
	})

	test('refuses a timelock that answers like a Compound Timelock but executes nothing', async () => {
		const { preview, requests } = await previewFixture('abuse-timelock-executes-nothing')
		assertRefused(preview, /executing proposal 1 did not make 0x7f08904bdF69bE49734b0D2039A5f830CeFc2EC9 execute its actions/)
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
	})

	test('refuses a proposal whose second action reverts at a real Compound Timelock, instead of showing the first action\'s transfer', async () => {
		const { preview } = await previewFixture('compound-timelock-second-action-reverts')
		// The first action sends 1 ether to the user and succeeds on its own, but the governor executes both actions in one transaction.
		assertRefused(preview, /executing action 2 of 2 of proposal 1 fails \(execution reverted: Timelock::executeTransaction: Transaction execution reverted\.\), and the governor's transaction reverts as a whole/)
	})

	test('gives an action that needs most of the gas what it needs, in the same block as the others', async () => {
		const { preview, requests } = await previewFixture('compound-timelock-one-heavy-action')
		const gasUsed = getExecution(preview).transactions.map((transaction) => transaction.ethSimulateV1CallResult.gasUsed)
		const gasLimit = recordedGasLimit(await loadFixture('compound-timelock-one-heavy-action'))
		assert.equal(gasUsed.length, 6)
		// The second action writes 480 storage slots, more gas than a sixth of the block, which an equal split of the block's gas would not have given it.
		const heavyActionGas = gasUsed[1] ?? 0n
		assert.ok(heavyActionGas > gasLimit / 6n, `${ heavyActionGas } is not more than a sixth of ${ gasLimit }`)
		assertExecutedInOneBlock(requests, 6)
	})

	test('runs all actions in one block, so an action that needs the block of an earlier one succeeds as in the governor\'s single transaction', async () => {
		const { preview, requests } = await previewFixture('compound-timelock-actions-in-the-same-block')
		const statuses = getExecution(preview).transactions.map((transaction) => transaction.ethSimulateV1CallResult.status)
		assert.deepEqual(statuses, ['success', 'success'])
		assertExecutedInOneBlock(requests, 2)
	})

	test('refuses a refund-heavy proposal that fits in one transaction only if each action is refunded on its own', async () => {
		const { preview } = await previewFixture('compound-timelock-refunds-near-transaction-limit')
		assertRefused(preview, /may need up to \d+ gas in the governor's single transaction before refunds \(its actions used \d+ apart\), more than the EIP-7825 limit of one transaction, 16777216/)
		if (preview.success) throw new Error('Expected no outcome')
		const [, bound, used] = /may need up to (\d+) gas .* used (\d+) apart/.exec(preview.errorMessage)?.map((value, index) => index === 0 ? undefined : BigInt(value)) ?? []
		// Its actions used less than the limit apart, which a plain sum would have accepted.
		assert.ok(used !== undefined && used < 16_777_216n)
		assert.ok(bound !== undefined && bound > 16_777_216n)
	})
})

describe('governance proposal execution preview after the user\'s simulation stack', () => {
	const stacks = [
		['makeRich', 'a make-rich balance'],
		['signedMessage', 'a signed message and its replaced ecrecover'],
		['safeExecution', 'a Gnosis Safe execution\'s approvals and executor funding, from the real Safe preparation'],
	] as const
	for (const [stack, overrides] of stacks) {
		test(`keeps the stack's overrides for ${ overrides }, and adds none of its own`, async () => {
			const { preview, requests, governor } = await previewFixture(`uniswap-bravo-queued-after-${ stack }`)
			const [transaction] = getExecution(preview).transactions
			assert.equal(transaction?.preSimulationTransaction.signedTransaction.to, governor)
			assert.equal(transaction?.ethSimulateV1CallResult.status, 'success')
			// previewFixture checked the override rule; the stack's overrides reached the node in front of the execution.
			assert.ok(simulateRequests(requests).some((simulation) => hasOverrides(simulation.blockStateCalls[0]?.stateOverrides) && simulation.blockStateCalls.length > 1))
		})
	}

	test('a Gnosis Safe execution on the stack is prepared by the real Safe preparation, and its transfer happens before the execution', async () => {
		const { requests, resultOf, stack } = await previewFixture('uniswap-bravo-queued-after-safeExecution')
		// prepareSafeExecutionSimulationInput approved the call for the Safe's owner and funded its executor.
		const preparedOverrides = stack[0]?.stateOverrides ?? {}
		assert.ok(preparedOverrides[addressString(EXAMPLE_SAFE)]?.stateDiff !== undefined)
		assert.ok(preparedOverrides[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)]?.balance !== undefined)
		assert.ok(stack[0]?.transactions[0]?.executedTransaction !== undefined)
		const outcomeRequest = requests.find((request) => request.method === 'eth_simulateV1' && request.params[0].blockStateCalls.length === 2)
		if (outcomeRequest === undefined) throw new Error('Expected the stack and the execution in one simulation')
		const stackCall = EthSimulateV1Result.parse(resultOf(outcomeRequest))[0]?.calls[0]
		if (stackCall?.status !== 'success') throw new Error('Expected the Safe execution to succeed')
		// The node logs the ether the Safe sends to 0x…dEaD.
		assert.ok(stackCall.logs.some((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS && log.topics[1] === EXAMPLE_SAFE && log.topics[2] === 0xdeadn))
	})
})

describe('governance ProposalCreated search', () => {
	const latestBlock = { number: 26_382_492n, timestamp: new Date(1_794_290_000_000) }
	const governor = 0x1234n
	const searchedBlocks = (range: { readonly fromBlock: bigint, readonly toBlock: bigint }) => range.toBlock - range.fromBlock + 1n
	const maximumRange = 2n * PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS + 1n

	test('searches at most a day of blocks either side of the creation block, in at most two requests', () => {
		const cases = [
			{ snapshot: latestBlock.number - 8000n, votingDelay: 0n, clockIsTimestamp: false },
			{ snapshot: latestBlock.number, votingDelay: latestBlock.number, clockIsTimestamp: false },
			{ snapshot: 10n, votingDelay: 0n, clockIsTimestamp: false },
			{ snapshot: 1_794_000_000n, votingDelay: 86_400n, clockIsTimestamp: true },
			{ snapshot: 1_762_754_000n, votingDelay: 0n, clockIsTimestamp: true },
		]
		for (const { snapshot, votingDelay, clockIsTimestamp } of cases) {
			const range = getProposalCreatedSearchRange(latestBlock, governor, snapshot, votingDelay, clockIsTimestamp)
			if (!range.success) throw new Error(range.errorMessage)
			assert.ok(range.value.fromBlock >= 0n && range.value.toBlock <= latestBlock.number && range.value.fromBlock <= range.value.toBlock)
			assert.ok(searchedBlocks(range.value) <= maximumRange)
			const queries = splitIntoLogQueries(range.value)
			assert.ok(queries.length <= 2)
			assert.equal(queries.reduce((total, query) => total + searchedBlocks(query), 0n), searchedBlocks(range.value))
			assert.ok(queries.every((query) => searchedBlocks(query) <= MAXIMUM_BLOCKS_PER_LOG_QUERY))
		}
	})

	test('refuses snapshot and voting delay values that point outside the chain', () => {
		const maximumUint256 = 2n ** 256n - 1n
		const refusals = [
			[maximumUint256, 0n, false, /created after the latest block/],
			[latestBlock.number + 1n, 0n, false, /created after the latest block/],
			[maximumUint256, 0n, true, /created after the latest block/],
			[5n, 6n, false, /created before its clock started/],
			[1n, 0n, true, /created before the chain's first block/],
		] as const
		for (const [snapshot, votingDelay, clockIsTimestamp, reason] of refusals) assertRefused(getProposalCreatedSearchRange(latestBlock, governor, snapshot, votingDelay, clockIsTimestamp), reason)
	})

	test('a governor reporting a snapshot past the latest block is refused without any eth_getLogs request', async () => {
		const { preview, requests } = await previewFixture('open-zeppelin-snapshot-past-latest-block')
		assertRefused(preview, /reports a proposal created after the latest block/)
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 0)
	})

	test('a governor whose snapshot points at a full search window is searched in two bounded requests', async () => {
		const { preview, requests } = await previewFixture('open-zeppelin-wide-proposal-created-search')
		assertRefused(preview, /its ProposalCreated events between blocks \d+ and \d+ do not name the proposal exactly once/)
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 2)
	})
})

describe('governance execution gas', () => {
	test('one transaction is limited to 2^24 gas where EIP-7825 is active, and to the block otherwise', () => {
		const block = { gasLimit: 60_000_000n, timestamp: new Date(1_794_290_000_000) }
		assert.deepEqual(getTransactionGasLimit(1n, block), { gas: 16_777_216n, source: 'the EIP-7825 limit of one transaction' })
		assert.deepEqual(getTransactionGasLimit(1n, { ...block, timestamp: new Date(1_764_798_550_000) }), { gas: 60_000_000n, source: 'the block gas limit' })
		assert.deepEqual(getTransactionGasLimit(8453n, block), { gas: 60_000_000n, source: 'the block gas limit' })
		assert.deepEqual(getTransactionGasLimit(1n, { ...block, gasLimit: 10_000_000n }), { gas: 10_000_000n, source: 'the block gas limit' })
	})

	test('splits a block\'s gas between calls by need, and gives calls that failed alone what the others leave', () => {
		const measuredLimits = gasLimitsByNeed(60_000_000n, [100_000n, 10_000_000n, 100_000n])
		if (measuredLimits === undefined) throw new Error('Expected gas limits')
		assert.ok(measuredLimits.reduce((total, gas) => total + gas, 0n) <= 60_000_000n)
		assert.ok((measuredLimits[1] ?? 0n) > 20_000_000n)
		const withUnmeasured = gasLimitsByNeed(60_000_000n, [100_000n, undefined])
		if (withUnmeasured === undefined) throw new Error('Expected gas limits')
		assert.ok((withUnmeasured[1] ?? 0n) > 59_000_000n && (withUnmeasured[0] ?? 0n) + (withUnmeasured[1] ?? 0n) <= 60_000_000n)
		assert.equal(gasLimitsByNeed(60_000_000n, [40_000_000n, 10_000_000n]), undefined)
	})
})
