import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { GOVERNOR_CODE_ADDRESS, getProposalCreatedSearchRange, getTransactionGasLimit, OSAKA_ACTIVATION_TIME_BY_CHAIN_ID, MAXIMUM_BLOCKS_PER_LOG_QUERY, PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS, simulateGovernanceProposalExecution, splitIntoLogQueries } from '../../app/ts/simulation/governanceProposalExecution.js'
import { SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../../app/ts/safe/safeExecutionSimulation.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getGovernorProposalForwarder } from '../../app/ts/utils/ethereumByteCodes.js'
import { EthereumData } from '../../app/ts/types/wire-types.js'
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
 * The preview's override rule. At the stack's own block positions a request may carry only the overrides the stack's own preparation produced. After the stack, a block may carry only GovernorProposalForwarder at the governor's address with the governor's own code, as the node returned it, moved to GOVERNOR_CODE_ADDRESS, and nothing else at any address. Returns whether the forwarder was used.
 */
const assertOverrideRule = async (ethereum: EthereumClientService, requests: readonly EthereumJsonRpcRequest[], resultOf: (request: EthereumJsonRpcRequest) => unknown, stack: SimulationStateInput, governor: bigint) => {
	const getStackOverrides = async () => {
		if (stack.length === 0) return []
		const latestBlock = await ethereum.getBlock(undefined)
		if (latestBlock === null) throw new Error('Expected the latest block')
		return (await ethereum.pinnedToBlock(latestBlock).ethSimulateV1Input(stack, latestBlock.number, undefined)).params[0].blockStateCalls.map((block) => block.stateOverrides ?? {})
	}
	const stackOverrides = await getStackOverrides()
	const governorCodeRequest = requests.find((request) => request.method === 'eth_getCode' && request.params[0] === governor)
	const forwarderOverrides = governorCodeRequest === undefined ? undefined : {
		[addressString(governor)]: { code: getGovernorProposalForwarder() },
		[addressString(GOVERNOR_CODE_ADDRESS)]: { code: EthereumData.parse(resultOf(governorCodeRequest)) },
	}
	let forwarderUsed = false
	for (const simulation of simulateRequests(requests)) {
		for (const [blockIndex, block] of simulation.blockStateCalls.entries()) {
			if (!hasOverrides(block.stateOverrides)) continue
			if (blockIndex < stackOverrides.length) {
				assert.deepStrictEqual(block.stateOverrides, stackOverrides[blockIndex])
				continue
			}
			assert.ok(forwarderOverrides !== undefined, `block ${ blockIndex }, after the stack, carries state overrides`)
			assert.deepStrictEqual(block.stateOverrides, forwarderOverrides)
			forwarderUsed = true
		}
	}
	// The stack's own overrides are kept: the execution runs on top of them.
	if (stackOverrides.some(hasOverrides)) assert.ok(simulateRequests(requests).some((simulation) => simulation.blockStateCalls.some((block, blockIndex) => hasOverrides(block.stateOverrides) && blockIndex < stackOverrides.length)))
	return forwarderUsed
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

const recordedGasLimit = (fixture: GovernanceFixture) => {
	const latestBlock = fixture.exchanges.find((exchange) => JSON.stringify(exchange.request).includes('"latest"'))?.result
	if (typeof latestBlock !== 'object' || latestBlock === null || !('gasLimit' in latestBlock) || typeof latestBlock.gasLimit !== 'string') throw new Error('Expected the recorded block gas limit')
	return BigInt(latestBlock.gasLimit)
}

// Replays a fixture through the preview, after the example stack it was recorded with, and checks the override rule and the log search bound on every request it sent.
const previewFixture = async (name: string, options: Parameters<typeof createReplayingEthereumClientService>[1] = {}) => {
	const fixture = await loadFixture(name)
	if (fixture.stack !== undefined && !isExampleStackName(fixture.stack)) throw new Error(`Unknown stack ${ fixture.stack }`)
	const { ethereum, requests, resultOf } = createReplayingEthereumClientService(fixture, options)
	const stack = await prepareExampleStack(ethereum, fixture.stack === undefined ? [] : EXAMPLE_STACKS[fixture.stack]())
	const governor = BigInt(fixture.governor)
	const preview = await simulateGovernanceProposalExecution(ethereum, stack, governor, BigInt(fixture.proposalId), WEBSITE)
	const forwarderUsed = await assertOverrideRule(ethereum, requests, resultOf, stack, governor)
	assertBoundedLogSearch(requests)
	return { preview, requests, resultOf, stack, governor, forwarderUsed, fixture }
}

// The simulation that produced the outcome: the stack's blocks, then the planned ones, with the execution last.
const outcomeSimulation = (requests: readonly EthereumJsonRpcRequest[], blockCount: number) => {
	const simulation = simulateRequests(requests).find((candidate) => candidate.blockStateCalls.length === blockCount)
	if (simulation === undefined) throw new Error(`Expected a simulation of ${ blockCount } blocks`)
	return simulation
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
	test('simulates a Uniswap GovernorBravo proposal that is being voted on as its governor queues and executes it, in one transaction each', async () => {
		const { preview, requests, governor, forwarderUsed } = await previewFixture('uniswap-bravo-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, UNISWAP_TIMELOCK)
		assert.equal(forwarderUsed, true)
		const [transaction, ...otherTransactions] = execution.transactions
		assert.equal(otherTransactions.length, 0)
		assert.equal(transaction?.preSimulationTransaction.signedTransaction.from, MOCK_ADDRESS)
		assert.equal(transaction?.preSimulationTransaction.signedTransaction.to, governor)
		if (transaction?.ethSimulateV1CallResult.status !== 'success') throw new Error('Expected the execution to succeed')
		// The real timelock executed the proposal's three actions; getActions of this proposal needs about 150000 gas, more than the 90000 the reads used to be limited to.
		assert.equal(transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === UNISWAP_TIMELOCK).length, 3)
		const [queueBlock, executionBlock] = outcomeSimulation(requests, 2).blockStateCalls
		const queueTime = queueBlock?.blockOverrides?.time
		const executionTime = executionBlock?.blockOverrides?.time
		if (queueTime === undefined || executionTime === undefined) throw new Error('Expected a queue block and an execution block')
		assert.equal((executionTime.getTime() - queueTime.getTime()) / 1000, TWO_DAYS_IN_SECONDS)
	})

	test('executes a queued Uniswap GovernorBravo proposal through the governor exactly as it was executed on chain', async () => {
		const { preview, governor, forwarderUsed } = await previewFixture('uniswap-bravo-queued')
		const [transaction, ...otherTransactions] = getExecution(preview).transactions
		if (transaction === undefined) throw new Error('Expected the execute transaction')
		assert.equal(otherTransactions.length, 0)
		assert.equal(forwarderUsed, false)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.from, MOCK_ADDRESS)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.to, governor)
		if (transaction.ethSimulateV1CallResult.status !== 'success') throw new Error('Expected the execution to succeed')
		// The proposal's real execution, 0xc3b82a4721717315ce420f5c5f422934e4f662f170da7bb70cc5aad337a34dc4, used 402330 gas and emitted 9 logs.
		assert.equal(transaction.ethSimulateV1CallResult.gasUsed, 402330n)
		assert.equal(transaction.ethSimulateV1CallResult.logs.length, 9)
	})

	test('runs an action that calls the Compound Timelock itself on the real timelock', async () => {
		const { preview } = await previewFixture('compound-bravo-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, COMPOUND_TIMELOCK)
		// Proposal 393 calls setPendingAdmin on the timelock itself, which the timelock code that used to replace it did not have.
		assert.deepEqual(execution.transactions.map((transaction) => transaction.ethSimulateV1CallResult.status), ['success'])
	})

	test('finds the actions of an OpenZeppelin governor in its ProposalCreated event and executes them through its TimelockController', async () => {
		const { preview, requests, governor, forwarderUsed } = await previewFixture('ens-governor-active')
		const [transaction, ...otherTransactions] = getExecution(preview).transactions
		if (transaction === undefined) throw new Error('Expected the executeBatch transaction')
		assert.equal(otherTransactions.length, 0)
		assert.equal(forwarderUsed, false)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.from, governor)
		assert.equal(transaction.preSimulationTransaction.signedTransaction.to, ENS_TIMELOCK)
		assert.equal(transaction.ethSimulateV1CallResult.status, 'success')
		// The search covers a day of blocks either side of the proposal's creation, in two requests.
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 2)
	})

	test('executes the actions of an OpenZeppelin governor with GovernorStorage through its Compound Timelock', async () => {
		const { preview, requests, forwarderUsed } = await previewFixture('compound-governor-active')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, COMPOUND_TIMELOCK)
		assert.equal(forwarderUsed, true)
		assert.deepEqual(execution.transactions.map((transaction) => transaction.ethSimulateV1CallResult.status), ['success'])
		assert.equal(requests.filter((request) => request.method === 'eth_getLogs').length, 0)
	})

	test('simulates the proposal after the simulation stack and queues it no earlier than a minute after the stack', async () => {
		const { preview, requests } = await previewFixture('ens-governor-succeeded-after-stack')
		const execution = getExecution(preview)
		assert.equal(execution.timelock, ENS_TIMELOCK)
		// The outcome holds only the execution block, not the stack or the queue block before it.
		assert.equal(execution.simulationState.simulationStateInput.length, 1)
		const [stackBlock, queueBlock, executionBlock] = outcomeSimulation(requests, 3).blockStateCalls
		assert.equal(stackBlock?.calls[0]?.from, EXAMPLE_STACK_SENDER)
		const stackTime = stackBlock?.blockOverrides?.time?.getTime()
		const queueTime = queueBlock?.blockOverrides?.time?.getTime()
		const executionTime = executionBlock?.blockOverrides?.time?.getTime()
		if (stackTime === undefined || queueTime === undefined || executionTime === undefined) throw new Error('Expected block times')
		// Voting on this proposal has ended, so it is queued as soon as the preview allows and executed after the timelock's minimum delay of two days.
		assert.equal((queueTime - stackTime) / 1000, 60)
		assert.equal((executionTime - queueTime) / 1000, TWO_DAYS_IN_SECONDS)
	})

	test('works on the block it started with when the chain moves on to a block with a lower gas limit', async () => {
		const laterLatestBlock = (recorded: unknown) => {
			if (typeof recorded !== 'object' || recorded === null || !('number' in recorded) || typeof recorded.number !== 'string') throw new Error('Expected a recorded block')
			return { ...recorded, number: `0x${ (BigInt(recorded.number) + 1n).toString(16) }`, gasLimit: '0x1312d00' }
		}
		const pinned = await previewFixture('uniswap-bravo-active', { laterLatestBlock })
		const unchanged = await previewFixture('uniswap-bravo-active')
		// The preview read the latest block once; every later read, simulation and balance lookup named that block.
		assert.equal(pinned.requests.filter((request) => request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest').length, 1)
		assert.deepEqual(getExecution(pinned.preview).transactions.map((transaction) => transaction.ethSimulateV1CallResult), getExecution(unchanged.preview).transactions.map((transaction) => transaction.ethSimulateV1CallResult))
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
		test(`${ name }: refuses before running anything, and overrides nothing`, async () => {
			const { preview, requests, governor, forwarderUsed } = await previewFixture(name)
			assertRefused(preview, reason)
			assert.equal(forwarderUsed, false)
			// Only the two batches of reads ran, and no call came from the governor.
			const simulations = simulateRequests(requests)
			assert.equal(simulations.length, 2)
			for (const simulation of simulations) {
				for (const block of simulation.blockStateCalls) assert.ok(block.calls.every((call) => call.from === MOCK_ADDRESS && call.from !== governor))
			}
		})
	}

	test('refuses a queued proposal whose governor pays out from execute instead of executing through its timelock', async () => {
		const { preview } = await previewFixture('abuse-queued-execute-pays-out')
		assertRefused(preview, /executing proposal 1 did not make 0x5c4075FCC531b2227dd1E6Aef747BeEe3a0A7067 execute its actions/)
	})

	test('refuses a timelock that answers like a Compound Timelock but executes nothing', async () => {
		const { preview } = await previewFixture('abuse-timelock-executes-nothing')
		// Its execute answer does not decode as the bytes a Compound Timelock returns, so the governor's execute reverts, as GovernorBravo's would.
		assertRefused(preview, /executing proposal 1 (fails|did not make 0x7f08904bdF69bE49734b0D2039A5f830CeFc2EC9 execute its actions)/)
	})

	test('a governor with a timelock of its own can only move what that timelock holds', async () => {
		const { preview } = await previewFixture('abuse-own-funded-timelock')
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
})

describe('governance proposal execution through a real Compound Timelock in one transaction', () => {
	const executionOf = async (name: string) => {
		const fixture = await previewFixture(name)
		const [transaction, ...otherTransactions] = getExecution(fixture.preview).transactions
		assert.equal(otherTransactions.length, 0)
		assert.equal(fixture.forwarderUsed, true)
		if (transaction?.ethSimulateV1CallResult.status !== 'success') throw new Error('Expected the execution to succeed')
		return { ...fixture, result: transaction.ethSimulateV1CallResult, transaction }
	}

	test('refuses a proposal whose second action reverts, instead of showing the first action\'s transfer', async () => {
		const { preview } = await previewFixture('compound-timelock-second-action-reverts')
		// The first action sends 1 ether to the user and the second reverts; the governor's one transaction reverts as a whole.
		assertRefused(preview, /executing proposal 1 fails \(execution reverted: Timelock::executeTransaction: Transaction execution reverted\.\)\.$/)
	})

	test('keeps a transient flag one action sets for the next, as the governor\'s single transaction does', async () => {
		const { result } = await executionOf('compound-timelock-transient-flag')
		// The second action pays 0x…BADD if the first action's transient flag is still set, and 0x…a11C if it was cleared between transactions.
		const etherTransfers = result.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
		assert.deepEqual(etherTransfers.map((log) => log.topics[2]), [0xbaddn])
	})

	test('runs an action that needs the block of an earlier one as the governor\'s single transaction does', async () => {
		await executionOf('compound-timelock-actions-in-the-same-block')
	})

	test('runs an action that calls back into the governor on the governor\'s own code', async () => {
		const { result, governor } = await executionOf('compound-timelock-calls-back-into-governor')
		// The governor's callBack emits CalledBack(msg.sender) from the governor's own code, with the timelock as the caller.
		const calledBack = result.logs.filter((log) => log.address === governor)
		assert.equal(calledBack.length, 1)
		assert.equal(BigInt(dataStringWith0xStart(calledBack[0]?.data ?? new Uint8Array())), 0x7878787878787878787878787878787878787878n)
	})

	test('refunds a proposal as one transaction, so one that clears what it wrote fits the per-transaction limit', async () => {
		const { result, transaction } = await executionOf('compound-timelock-refunds-near-transaction-limit')
		// It writes 560 slots and clears them; before its refund it needs more than its own gas limit would leave if each action were refunded alone.
		assert.equal(transaction.preSimulationTransaction.signedTransaction.gas, 16_777_216n - 160_000n)
		assert.ok(result.gasUsed < transaction.preSimulationTransaction.signedTransaction.gas)
		if (result.maxUsedGas !== undefined) assert.ok(result.maxUsedGas > result.gasUsed)
	})

	test('refuses a proposal that needs more gas than one transaction may use', async () => {
		const { preview } = await previewFixture('compound-timelock-over-transaction-gas-limit')
		assertRefused(preview, /executing proposal 1 fails \(.*\), after using \d+ of the 16647216 gas it may have: the EIP-7825 limit of one transaction, 16777216, less 130000 for the governor's own work\./)
	})

	test('limits a transaction by the planned block\'s time, so an execution after Osaka gets the EIP-7825 limit though the parent block was before it', async () => {
		const { requests, fixture } = await executionOf('compound-timelock-executes-after-osaka')
		const [queueBlock, executionBlock] = outcomeSimulation(requests, 2).blockStateCalls
		const parentGasLimit = recordedGasLimit(fixture)
		const queueTime = queueBlock?.blockOverrides?.time
		const executionTime = executionBlock?.blockOverrides?.time
		if (queueTime === undefined || executionTime === undefined) throw new Error('Expected block times')
		const osaka = OSAKA_ACTIVATION_TIME_BY_CHAIN_ID.get(1n) ?? 0n
		assert.ok(BigInt(queueTime.getTime() / 1000) < osaka && BigInt(executionTime.getTime() / 1000) >= osaka)
		assert.equal(queueBlock?.calls[0]?.gas, parentGasLimit - 130_000n)
		assert.equal(executionBlock?.calls[0]?.gas, 16_777_216n - 130_000n)
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
	test('one transaction is limited to 2^24 gas from Osaka on mainnet, Sepolia and Hoodi, and to the block otherwise', () => {
		for (const [chainId, activationTime] of OSAKA_ACTIVATION_TIME_BY_CHAIN_ID) {
			assert.deepEqual(getTransactionGasLimit(chainId, activationTime - 1n, 60_000_000n), { gas: 60_000_000n, source: 'the block gas limit' })
			assert.deepEqual(getTransactionGasLimit(chainId, activationTime, 60_000_000n), { gas: 16_777_216n, source: 'the EIP-7825 limit of one transaction' })
			assert.deepEqual(getTransactionGasLimit(chainId, activationTime, 10_000_000n), { gas: 10_000_000n, source: 'the block gas limit' })
		}
		assert.deepEqual([...OSAKA_ACTIVATION_TIME_BY_CHAIN_ID.keys()], [1n, 11_155_111n, 560_048n])
		assert.deepEqual(getTransactionGasLimit(8453n, 1_900_000_000n, 60_000_000n), { gas: 60_000_000n, source: 'the block gas limit' })
	})
})
