import type { EthereumBlockHeader as MaybeEthereumBlockHeader } from '../types/wire-types.js'
import type { PreSimulationTransaction, SimulationState, SimulationStateInput, SimulationStateInputBlock } from '../types/visualizer-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { EthSimulateV1CallResult } from '../types/ethSimulate-types.js'
import { CompoundTimelockAbi, GovernorAbi, TimelockControllerAbi } from '../utils/abi.js'
import { decodeEventStrict, decodeFunctionOutput, encodeAbiValues, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bigintSecondsToDate, bytes32String, checksummedAddress, dataStringWith0xStart, dateToBigintSeconds, generate256BitRandomBigInt, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { type Hex, concat, isAbiDataDecodeError, keccak256, toEventSelector, toFunctionSelector } from '../utils/ethereumPrimitives.js'
import { type EthereumClientService, getNextBlockTimeStampOverride } from './services/EthereumClientService.js'
import { createSimulationState } from './services/SimulationModeEthereumClientService.js'
import { mockSignTransaction } from './services/simulationTransactionSigning.js'

type EthereumBlockHeader = NonNullable<MaybeEthereumBlockHeader>

// The proposal states, in the order of the state(proposalId) enum that GovernorAlpha, GovernorBravo and OpenZeppelin's Governor share.
const PROPOSAL_STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'] as const
type ProposalState = typeof PROPOSAL_STATES[number]

const PROPOSER_ROLE = keccak256(new TextEncoder().encode('PROPOSER_ROLE'))
const EXECUTOR_ROLE = keccak256(new TextEncoder().encode('EXECUTOR_ROLE'))
const PROPOSAL_CREATED_TOPIC = BigInt(toEventSelector('ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)'))
const EXECUTE_TRANSACTION_TOPIC = BigInt(toEventSelector('ExecuteTransaction(bytes32,address,uint256,string,bytes,uint256)'))
const CALL_EXECUTED_TOPIC = BigInt(toEventSelector('CallExecuted(bytes32,uint256,address,uint256,bytes)'))
const ZERO_BYTES32 = bytes32String(0n)
const SECONDS_PER_BLOCK = 12n
// Queueing at least this far ahead keeps a block that arrives while the preview runs from overtaking the queue block, which would make the queued eta too early for the timelock.
const MINIMUM_SECONDS_UNTIL_QUEUE = 60n
// Compound's Timelock allows at most 30 days and TimelockControllers in use stay well under this. A longer delay means the contract is not a timelock the preview can run to its execution time.
const MAXIMUM_TIMELOCK_DELAY_SECONDS = 365n * 24n * 60n * 60n
// A proposal's ProposalCreated event is searched this many blocks either side of the block its snapshot and votingDelay point to. The governor's votingDelay may have changed since the proposal was made, and a timestamp clock gives only an estimate of the block.
export const PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS = 7200n
// The largest block range one eth_getLogs request asks for, a limit common to public RPCs. The whole search is at most two such requests.
export const MAXIMUM_BLOCKS_PER_LOG_QUERY = 10_000n

// One action of a proposal. Compound-style governors keep the function signature apart from its arguments; for OpenZeppelin governors signature is empty and data is the whole call data.
type ProposalAction = {
	readonly target: bigint
	readonly value: bigint
	readonly signature: string
	readonly data: Hex
}

// What the governor answers about the proposal, apart from its actions, which can take an eth_getLogs search to find.
type GovernorReads = {
	readonly timelock: bigint
	readonly state: ProposalState
	readonly eta: bigint | undefined
	readonly votingEndsAt: bigint | undefined
	readonly actionsReply: Hex | undefined
	readonly detailsReply: Hex | undefined
	readonly snapshot: bigint | undefined
	readonly votingDelay: bigint | undefined
	readonly clockIsTimestamp: boolean
}

type ProposalActions = {
	readonly actions: readonly ProposalAction[]
	// The call to the governor's own execute: by id for Compound-style governors, by actions and description hash for OpenZeppelin governors.
	readonly executeCall: Hex
}

type Timelock = { readonly type: 'CompoundTimelock' | 'TimelockController', readonly address: bigint, readonly delay: bigint }

type PlannedCall = {
	readonly from: bigint
	readonly to: bigint
	readonly input: Hex
	// What the call does, for the reason given when it fails.
	readonly description: string
}

type ExecutionPlan = {
	readonly blocks: readonly {
		readonly time: bigint
		readonly calls: readonly PlannedCall[]
		// shared: the calls split one block's gas, so all of them run at that block's time. own: each call may use a whole block's gas, and the node runs them in consecutive blocks.
		readonly gas: 'shared' | 'own'
	}[]
	readonly executionTime: bigint
	// Whether the execution block's results contain the timelock executing each of the proposal's actions, in order.
	readonly isProposalExecutedBy: (callResults: readonly EthSimulateV1CallResult[]) => boolean
}

// What the preview answers when the governor, its timelock or the proposal cannot be executed as a governor would: no outcome, and why.
type Refusal = { readonly success: false, readonly errorMessage: string }
type Checked<Value> = { readonly success: true, readonly value: Value } | Refusal
const refuse = (reason: string): Refusal => ({ success: false, errorMessage: `No outcome is simulated: ${ reason }` })
const accept = <Value>(value: Value): Checked<Value> => ({ success: true, value })

export type GovernanceExecutionPreview = { readonly success: true, readonly simulationState: SimulationState, readonly timelock: bigint, readonly executionTime: Date } | Refusal

const callDataOf = (action: ProposalAction): Hex => action.signature === '' ? action.data : concat([toFunctionSelector(action.signature), action.data])

const decodeOrUndefined = <Decoded>(reply: Hex | undefined, decode: (reply: Hex) => Decoded) => {
	if (reply === undefined) return undefined
	try {
		return decode(reply)
	} catch (error: unknown) {
		if (isAbiDataDecodeError(error)) return undefined
		throw error
	}
}

const estimateTimeOfBlock = (parentBlock: EthereumBlockHeader, blockNumber: bigint) => dateToBigintSeconds(parentBlock.timestamp) + (blockNumber > parentBlock.number ? blockNumber - parentBlock.number : 0n) * SECONDS_PER_BLOCK

// Reads view functions in one eth_simulateV1 request on the chain at parentBlock, with no state overrides. A revert reads as undefined, so a function a contract does not implement is absent; an RPC failure still throws.
const readContracts = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, reads: readonly { readonly to: bigint, readonly input: Hex }[]) => {
	const gas = parentBlock.gasLimit / BigInt(reads.length)
	const calls = reads.map((read) => ({ type: '1559' as const, from: MOCK_ADDRESS, to: read.to, input: stringToUint8Array(read.input), gas, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }))
	const results = (await ethereum.ethSimulateV1([{ calls }], parentBlock.number, undefined))[0]?.calls
	if (results === undefined || results.length !== reads.length) throw new Error('The node did not answer every governance read.')
	return results.map((result) => result.status === 'success' ? dataStringWith0xStart(result.returnData) : undefined)
}

const readGovernor = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, proposalId: bigint): Promise<Checked<GovernorReads>> => {
	const readFromGovernor = (input: Hex) => ({ to: governor, input })
	const [timelockReply, stateReply, actionsReply, proposalsReply, detailsReply, etaReply, deadlineReply, snapshotReply, votingDelayReply, clockModeReply] = await readContracts(ethereum, parentBlock, [
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'timelock', [])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'state', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'getActions', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'proposals', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'proposalDetails', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'proposalEta', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'proposalDeadline', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'proposalSnapshot', [proposalId])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'votingDelay', [])),
		readFromGovernor(encodeFunctionCall(GovernorAbi, 'CLOCK_MODE', [])),
	])
	const timelock = decodeOrUndefined(timelockReply, (reply) => decodeFunctionOutput(GovernorAbi, 'timelock', reply))
	const stateIndex = decodeOrUndefined(stateReply, (reply) => decodeFunctionOutput(GovernorAbi, 'state', reply))
	const state = stateIndex === undefined ? undefined : PROPOSAL_STATES[Number(stateIndex)]
	if (timelock === undefined || state === undefined) return refuse(`${ checksummedAddress(governor) } does not answer timelock() and state(${ proposalId }) as a Compound or OpenZeppelin governor with a timelock does.`)

	// GovernorAlpha and GovernorBravo return more fields after endBlock, and the two differ there, so only the start they share is decoded.
	const compoundProposal = decodeOrUndefined(proposalsReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposals', `0x${ reply.slice(2, 2 + 5 * 64) }`))
	const [id, _proposer, compoundEta, _startBlock, endBlock] = compoundProposal ?? []
	const isCompoundProposal = id === proposalId && compoundEta !== undefined && endBlock !== undefined
	const clockIsTimestamp = decodeOrUndefined(clockModeReply, (reply) => decodeFunctionOutput(GovernorAbi, 'CLOCK_MODE', reply))?.includes('mode=timestamp') === true
	const deadline = decodeOrUndefined(deadlineReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalDeadline', reply))
	const openZeppelinVotingEndsAt = deadline === undefined ? undefined : clockIsTimestamp ? deadline : estimateTimeOfBlock(parentBlock, deadline)
	return accept({
		timelock: BigInt(timelock),
		state,
		eta: isCompoundProposal ? compoundEta : decodeOrUndefined(etaReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalEta', reply)),
		votingEndsAt: isCompoundProposal ? estimateTimeOfBlock(parentBlock, endBlock) : openZeppelinVotingEndsAt,
		actionsReply,
		detailsReply,
		snapshot: decodeOrUndefined(snapshotReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalSnapshot', reply)),
		votingDelay: decodeOrUndefined(votingDelayReply, (reply) => decodeFunctionOutput(GovernorAbi, 'votingDelay', reply)),
		clockIsTimestamp,
	})
}

/**
 * The blocks to search for a proposal's ProposalCreated event: PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS either side of the block the proposal was created in according to its snapshot and votingDelay, within the chain. A governor chooses both values, so whatever it answers, the range is at most twice the margin, and values that point past the latest block or before the first one are refused.
 */
export const getProposalCreatedSearchRange = (parentBlock: Pick<EthereumBlockHeader, 'number' | 'timestamp'>, governor: bigint, snapshot: bigint, votingDelay: bigint, clockIsTimestamp: boolean): Checked<{ readonly fromBlock: bigint, readonly toBlock: bigint }> => {
	const reportedBy = `${ checksummedAddress(governor) } reports a proposal`
	if (votingDelay > snapshot) return refuse(`${ reportedBy } created before its clock started (snapshot ${ snapshot }, votingDelay ${ votingDelay }).`)
	const createdAt = snapshot - votingDelay
	const latestTime = dateToBigintSeconds(parentBlock.timestamp)
	if (clockIsTimestamp ? createdAt > latestTime : createdAt > parentBlock.number) return refuse(`${ reportedBy } created after the latest block (snapshot ${ snapshot }, votingDelay ${ votingDelay }).`)
	const createdAroundBlock = clockIsTimestamp ? parentBlock.number - (latestTime - createdAt) / SECONDS_PER_BLOCK : createdAt
	if (createdAroundBlock + PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS < 0n) return refuse(`${ reportedBy } created before the chain's first block, at 12 seconds a block (snapshot ${ snapshot }, votingDelay ${ votingDelay }).`)
	const fromBlock = createdAroundBlock > PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS ? createdAroundBlock - PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS : 0n
	const toBlock = createdAroundBlock + PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS < parentBlock.number ? createdAroundBlock + PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS : parentBlock.number
	return accept({ fromBlock, toBlock })
}

export const splitIntoLogQueries = ({ fromBlock, toBlock }: { readonly fromBlock: bigint, readonly toBlock: bigint }) => {
	const queries: { readonly fromBlock: bigint, readonly toBlock: bigint }[] = []
	for (let start = fromBlock; start <= toBlock; start += MAXIMUM_BLOCKS_PER_LOG_QUERY) {
		const end = start + MAXIMUM_BLOCKS_PER_LOG_QUERY - 1n
		queries.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock })
	}
	return queries
}

// OpenZeppelin governors without GovernorStorage list a proposal's actions only in the ProposalCreated event they emit when it is proposed.
const findProposalCreatedEvent = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, proposalId: bigint, snapshot: bigint, votingDelay: bigint, clockIsTimestamp: boolean) => {
	const range = getProposalCreatedSearchRange(parentBlock, governor, snapshot, votingDelay, clockIsTimestamp)
	if (!range.success) return range
	const queries = splitIntoLogQueries(range.value)
	const logs = (await Promise.all(queries.map(async ({ fromBlock, toBlock }) => await ethereum.getLogs({ address: governor, fromBlock, toBlock, topics: [PROPOSAL_CREATED_TOPIC] }, undefined)))).flat()
	const events = logs.flatMap((log) => {
		const decoded = decodeOrUndefined(dataStringWith0xStart(log.data), (data) => decodeEventStrict(GovernorAbi, { data, topics: log.topics.map(bytes32String) }))
		return decoded?.eventName === 'ProposalCreated' && decoded.args.proposalId === proposalId ? [decoded.args] : []
	})
	const [event, ...otherEvents] = events
	if (event === undefined || otherEvents.length > 0) return refuse(`${ checksummedAddress(governor) } does not list the actions of proposal ${ proposalId }, and its ProposalCreated events between blocks ${ range.value.fromBlock } and ${ range.value.toBlock } do not name the proposal exactly once.`)
	return accept(event)
}

const readProposalActions = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, proposalId: bigint, reads: GovernorReads): Promise<Checked<ProposalActions>> => {
	const differentLengths = refuse(`${ checksummedAddress(governor) } lists actions of different lengths for proposal ${ proposalId }.`)
	const compoundActions = decodeOrUndefined(reads.actionsReply, (reply) => decodeFunctionOutput(GovernorAbi, 'getActions', reply))
	if (compoundActions !== undefined) {
		const [targets, values, signatures, calldatas] = compoundActions
		if (values.length !== targets.length || signatures.length !== targets.length || calldatas.length !== targets.length) return differentLengths
		const actions = targets.map((target, index) => ({ target: BigInt(target), value: values[index] ?? 0n, signature: signatures[index] ?? '', data: calldatas[index] ?? '0x' }))
		return accept({ actions, executeCall: encodeFunctionCall(GovernorAbi, 'execute', [proposalId]) })
	}

	const getOpenZeppelinActions = async () => {
		const details = decodeOrUndefined(reads.detailsReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalDetails', reply))
		if (details !== undefined) return accept({ targets: details[0], values: details[1], calldatas: details[2], descriptionHash: details[3] })
		if (reads.snapshot === undefined || reads.votingDelay === undefined) return refuse(`${ checksummedAddress(governor) } does not list the actions of proposal ${ proposalId } through getActions, proposalDetails or its ProposalCreated event.`)
		const event = await findProposalCreatedEvent(ethereum, parentBlock, governor, proposalId, reads.snapshot, reads.votingDelay, reads.clockIsTimestamp)
		if (!event.success) return event
		const { targets, values, signatures, calldatas, description } = event.value
		if (signatures.length !== calldatas.length) return differentLengths
		// GovernorCompatibilityBravo emits a signature apart from its arguments, as GovernorBravo does; other OpenZeppelin governors emit empty signatures.
		const fullCalldatas = calldatas.map((data, index) => callDataOf({ target: 0n, value: 0n, signature: signatures[index] ?? '', data }))
		return accept({ targets, values, calldatas: fullCalldatas, descriptionHash: keccak256(new TextEncoder().encode(description)) })
	}
	const openZeppelinActions = await getOpenZeppelinActions()
	if (!openZeppelinActions.success) return openZeppelinActions
	const { targets, values, calldatas, descriptionHash } = openZeppelinActions.value
	if (values.length !== targets.length || calldatas.length !== targets.length) return differentLengths
	const actions = targets.map((target, index) => ({ target: BigInt(target), value: values[index] ?? 0n, signature: '', data: calldatas[index] ?? '0x' }))
	return accept({ actions, executeCall: encodeFunctionCall(GovernorAbi, 'execute', [targets, values, calldatas, descriptionHash]) })
}

// Recognises the timelock from its own answers on chain, not from anything the governor says, and requires that it lets this governor queue and execute.
const identifyTimelock = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, timelock: bigint): Promise<Checked<Timelock>> => {
	const readTimelock = (input: Hex) => ({ to: timelock, input })
	const [adminReply, delayReply, gracePeriodReply, minDelayReply, governorProposesReply, governorExecutesReply, anyoneExecutesReply] = await readContracts(ethereum, parentBlock, [
		readTimelock(encodeFunctionCall(CompoundTimelockAbi, 'admin', [])),
		readTimelock(encodeFunctionCall(CompoundTimelockAbi, 'delay', [])),
		readTimelock(encodeFunctionCall(CompoundTimelockAbi, 'GRACE_PERIOD', [])),
		readTimelock(encodeFunctionCall(TimelockControllerAbi, 'getMinDelay', [])),
		readTimelock(encodeFunctionCall(TimelockControllerAbi, 'hasRole', [PROPOSER_ROLE, addressString(governor)])),
		readTimelock(encodeFunctionCall(TimelockControllerAbi, 'hasRole', [EXECUTOR_ROLE, addressString(governor)])),
		readTimelock(encodeFunctionCall(TimelockControllerAbi, 'hasRole', [EXECUTOR_ROLE, addressString(0n)])),
	])
	const name = `${ checksummedAddress(timelock) }, which ${ checksummedAddress(governor) } names as its timelock,`
	const accepted = (type: Timelock['type'], delay: bigint) => delay > MAXIMUM_TIMELOCK_DELAY_SECONDS ? refuse(`${ name } has a delay of ${ delay } seconds, more than a year.`) : accept({ type, address: timelock, delay })
	const admin = decodeOrUndefined(adminReply, (reply) => decodeFunctionOutput(CompoundTimelockAbi, 'admin', reply))
	const delay = decodeOrUndefined(delayReply, (reply) => decodeFunctionOutput(CompoundTimelockAbi, 'delay', reply))
	const gracePeriod = decodeOrUndefined(gracePeriodReply, (reply) => decodeFunctionOutput(CompoundTimelockAbi, 'GRACE_PERIOD', reply))
	if (admin !== undefined && delay !== undefined && gracePeriod !== undefined) {
		if (BigInt(admin) !== governor) return refuse(`${ name } is a Compound Timelock whose admin is ${ admin }, so this governor cannot execute through it.`)
		return accepted('CompoundTimelock', delay)
	}
	const minDelay = decodeOrUndefined(minDelayReply, (reply) => decodeFunctionOutput(TimelockControllerAbi, 'getMinDelay', reply))
	const governorProposes = decodeOrUndefined(governorProposesReply, (reply) => decodeFunctionOutput(TimelockControllerAbi, 'hasRole', reply))
	if (minDelay !== undefined && governorProposes !== undefined) {
		if (!governorProposes) return refuse(`${ name } is a TimelockController that does not give this governor the proposer role.`)
		const governorExecutes = decodeOrUndefined(governorExecutesReply, (reply) => decodeFunctionOutput(TimelockControllerAbi, 'hasRole', reply)) === true
		const anyoneExecutes = decodeOrUndefined(anyoneExecutesReply, (reply) => decodeFunctionOutput(TimelockControllerAbi, 'hasRole', reply)) === true
		if (!governorExecutes && !anyoneExecutes) return refuse(`${ name } is a TimelockController that does not let this governor execute.`)
		return accepted('TimelockController', minDelay)
	}
	return refuse(`${ name } is neither a Compound Timelock nor an OpenZeppelin TimelockController.`)
}

// The timelock's logs of one event, in the order it emitted them. Filtering on the event's topic first keeps the timelock's other events, such as Compound's QueueTransaction, out of the decoding.
const timelockEventLogs = (timelock: bigint, topic: bigint, callResults: readonly EthSimulateV1CallResult[]) => callResults.flatMap((callResult) => callResult.status === 'success' ? callResult.logs.filter((log) => log.address === timelock && log.topics[0] === topic) : [])

const isExecutedByCompoundTimelock = (timelock: bigint, actions: readonly ProposalAction[], eta: bigint) => (callResults: readonly EthSimulateV1CallResult[]) => {
	const executedHashes = timelockEventLogs(timelock, EXECUTE_TRANSACTION_TOPIC, callResults).flatMap((log) => {
		const decoded = decodeOrUndefined(dataStringWith0xStart(log.data), (data) => decodeEventStrict(CompoundTimelockAbi, { data, topics: log.topics.map(bytes32String) }))
		return decoded?.eventName === 'ExecuteTransaction' ? [decoded.args.txHash.toLowerCase()] : []
	})
	const executionHash = (action: ProposalAction, signature: string, data: Hex) => keccak256(encodeAbiValues(['address', 'uint256', 'string', 'bytes', 'uint256'], [addressString(action.target), action.value, signature, data, eta])).toLowerCase()
	// GovernorBravo hands the timelock a signature and its arguments, OpenZeppelin's GovernorTimelockCompound the whole call data with an empty signature, so either hash is the action's.
	const isActionExecuted = (action: ProposalAction, executedHash: string | undefined) => executedHash === executionHash(action, action.signature, action.data) || executedHash === executionHash(action, '', callDataOf(action))
	return executedHashes.length === actions.length && actions.every((action, index) => isActionExecuted(action, executedHashes[index]))
}

const isExecutedByTimelockController = (timelock: bigint, actions: readonly ProposalAction[]) => (callResults: readonly EthSimulateV1CallResult[]) => {
	const executedCalls = timelockEventLogs(timelock, CALL_EXECUTED_TOPIC, callResults).flatMap((log) => {
		const decoded = decodeOrUndefined(dataStringWith0xStart(log.data), (data) => decodeEventStrict(TimelockControllerAbi, { data, topics: log.topics.map(bytes32String) }))
		return decoded?.eventName === 'CallExecuted' ? [decoded.args] : []
	})
	return executedCalls.length === actions.length && actions.every((action, index) => {
		const executed = executedCalls[index]
		return executed !== undefined && executed.index === BigInt(index) && BigInt(executed.target) === action.target && executed.value === action.value && executed.data.toLowerCase() === callDataOf(action).toLowerCase()
	})
}

const isExecutedByTimelock = (timelock: Timelock, actions: readonly ProposalAction[], eta: bigint) => timelock.type === 'CompoundTimelock' ? isExecutedByCompoundTimelock(timelock.address, actions, eta) : isExecutedByTimelockController(timelock.address, actions)

// A proposal that is not queued yet is simulated as passing: the governor queues its actions at its timelock when voting ends, and executes them once the timelock's delay has passed. Both are calls from the governor to the timelock, which checks them as it checks the governor's own queue and execute. Any ETH an action sends comes from the timelock's balance.
const planQueueAndExecution = (stackEndTime: bigint, governor: bigint, proposalId: bigint, votingEndsAt: bigint | undefined, actions: readonly ProposalAction[], timelock: Timelock): ExecutionPlan => {
	const earliestQueueTime = stackEndTime + MINIMUM_SECONDS_UNTIL_QUEUE
	const queueTime = votingEndsAt !== undefined && votingEndsAt + 1n > earliestQueueTime ? votingEndsAt + 1n : earliestQueueTime
	const executionTime = queueTime + timelock.delay
	const isProposalExecutedBy = isExecutedByTimelock(timelock, actions, executionTime)
	const fromGovernor = (input: Hex, description: string): PlannedCall => ({ from: governor, to: timelock.address, input, description })
	const ofProposal = (index: number) => `action ${ index + 1 } of ${ actions.length } of proposal ${ proposalId }`
	if (timelock.type === 'CompoundTimelock') {
		// Compound's Timelock takes one action per call, so the governor's single queue and execute transactions are simulated as one call per action. They are not atomic here, so any failing call refuses the whole outcome, as the governor's transaction would revert as a whole.
		const transactionArguments = (action: ProposalAction) => [addressString(action.target), action.value, action.signature, action.data, executionTime] as const
		return {
			blocks: [
				// The governor queues every action in one transaction at one time, and queueing costs the same small amount for any action, so the queue calls share one block.
				{ time: queueTime, gas: 'shared', calls: actions.map((action, index) => fromGovernor(encodeFunctionCall(CompoundTimelockAbi, 'queueTransaction', transactionArguments(action)), `queueing ${ ofProposal(index) }`)) },
				// An action may need most of a block's gas, so each execution call gets a whole block's gas; the total is checked against one block afterwards.
				{ time: executionTime, gas: 'own', calls: actions.map((action, index) => fromGovernor(encodeFunctionCall(CompoundTimelockAbi, 'executeTransaction', transactionArguments(action)), `executing ${ ofProposal(index) }`)) },
			],
			executionTime,
			isProposalExecutedBy,
		}
	}
	// The proposal id as salt keeps the simulated operation apart from any operation already scheduled at the timelock.
	const batch = [actions.map((action) => addressString(action.target)), actions.map((action) => action.value), actions.map(callDataOf), ZERO_BYTES32, bytes32String(proposalId)] as const
	return {
		blocks: [
			{ time: queueTime, gas: 'own', calls: [fromGovernor(encodeFunctionCall(TimelockControllerAbi, 'scheduleBatch', [...batch, timelock.delay]), `scheduling proposal ${ proposalId }`)] },
			{ time: executionTime, gas: 'own', calls: [fromGovernor(encodeFunctionCall(TimelockControllerAbi, 'executeBatch', batch), `executing proposal ${ proposalId }`)] },
		],
		executionTime,
		isProposalExecutedBy,
	}
}

// Proposals that will not be executed are refused before their actions are looked up.
const checkExecutableState = (governor: bigint, proposalId: bigint, reads: GovernorReads): Checked<undefined> => {
	switch (reads.state) {
		case 'Pending':
		case 'Active':
		case 'Succeeded': return accept(undefined)
		case 'Queued': return reads.eta === undefined || reads.eta === 0n ? refuse(`proposal ${ proposalId } is queued, but ${ checksummedAddress(governor) } does not report when it can be executed.`) : accept(undefined)
		case 'Canceled':
		case 'Defeated':
		case 'Expired':
		case 'Executed': return refuse(`proposal ${ proposalId } is ${ reads.state.toLowerCase() }, so it will not be executed.`)
	}
}

// Plans the proposal's execution after the simulation stack, whose last block is at stackEndTime.
const planExecution = (stackEndTime: bigint, governor: bigint, proposalId: bigint, reads: GovernorReads, proposal: ProposalActions, timelock: Timelock): ExecutionPlan => {
	if (reads.state !== 'Queued' || reads.eta === undefined) return planQueueAndExecution(stackEndTime, governor, proposalId, reads.votingEndsAt, proposal.actions, timelock)
	// A queued proposal is executed as anyone can execute it: through the governor's own execute, in one transaction, once its eta has passed.
	const earliestTime = stackEndTime + SECONDS_PER_BLOCK
	const executionTime = reads.eta > earliestTime ? reads.eta : earliestTime
	return {
		blocks: [{ time: executionTime, gas: 'own', calls: [{ from: MOCK_ADDRESS, to: governor, input: proposal.executeCall, description: `executing proposal ${ proposalId } through ${ checksummedAddress(governor) }` }] }],
		executionTime,
		isProposalExecutedBy: isExecutedByTimelock(timelock, proposal.actions, reads.eta),
	}
}

// The governance preview's own blocks never carry state overrides or signed messages: whatever overrides the simulation holds come from the user's prepared simulation stack before them, never from an address the governor or the proposal chose.
const toSimulationInputBlocks = (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, plan: ExecutionPlan, website: Website): SimulationStateInput => plan.blocks.map((block): SimulationStateInputBlock => {
	const gas = block.gas === 'shared' ? parentBlock.gasLimit / BigInt(block.calls.length) : parentBlock.gasLimit
	return {
		stateOverrides: {},
		transactions: block.calls.map((call): PreSimulationTransaction => {
			const transaction = { type: '1559' as const, from: call.from, to: call.to, value: 0n, input: stringToUint8Array(call.input), gas, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], chainId: ethereum.getChainId(), nonce: 0n }
			return { signedTransaction: mockSignTransaction(transaction), website, created: new Date(), originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] }, transactionIdentifier: generate256BitRandomBigInt() }
		}),
		signedMessages: [],
		blockTimeManipulation: { type: 'SetTimetamp', timeToSet: block.time },
		simulateWithZeroBaseFee: true,
	}
})

/**
 * Simulates what executing a governance proposal does, as the governor's own timelock executes it, after the user's simulation stack. The governor, its timelock and the proposal are read from the chain's latest block, and the execution runs through the real governor and timelock code.
 * The governor and the proposal never choose a state override: the preview adds none of its own, so the only overrides in the simulation are those the stack's own preparation produced (make-rich balances, Gnosis Safe execution approvals, the replaced ecrecover of signed messages).
 * The governor has to be a Compound-style or OpenZeppelin governor whose timelock() is a Compound Timelock or an OpenZeppelin TimelockController that accepts it. Anything else, any proposal that will not be executed, and any execution that fails, gets a reason instead of an outcome.
 * stackSimulationInput has to be prepared for the node already (prepareSafeExecutionsForRpc).
 */
export const simulateGovernanceProposalExecution = async (ethereum: EthereumClientService, stackSimulationInput: SimulationStateInput, governor: bigint, proposalId: bigint, website: Website): Promise<GovernanceExecutionPreview> => {
	const parentBlock = await ethereum.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	const reads = await readGovernor(ethereum, parentBlock, governor, proposalId)
	if (!reads.success) return reads
	const timelock = await identifyTimelock(ethereum, parentBlock, governor, reads.value.timelock)
	if (!timelock.success) return timelock
	const executableState = checkExecutableState(governor, proposalId, reads.value)
	if (!executableState.success) return executableState
	// Looking up the actions can take an eth_getLogs search, so it waits until the governor, its timelock and the proposal's state are known to be worth it.
	const proposal = await readProposalActions(ethereum, parentBlock, governor, proposalId, reads.value)
	if (!proposal.success) return proposal
	if (proposal.value.actions.length === 0) return refuse(`proposal ${ proposalId } has no actions.`)
	const stackEndTime = dateToBigintSeconds(stackSimulationInput.reduce((previousTime, block) => getNextBlockTimeStampOverride(previousTime, block.blockTimeManipulation), parentBlock.timestamp))
	const plan = planExecution(stackEndTime, governor, proposalId, reads.value, proposal.value, timelock.value)
	const simulationState = await createSimulationState(ethereum, undefined, [...stackSimulationInput, ...toSimulationInputBlocks(ethereum, parentBlock, plan, website)])
	if (simulationState.success === false) throw new Error(simulationState.jsonRpcError.error.message)
	const planBlocks = simulationState.simulatedBlocks.slice(-plan.blocks.length)
	const executionBlock = planBlocks[planBlocks.length - 1]
	if (executionBlock === undefined || planBlocks.length !== plan.blocks.length) throw new Error('The execution of the proposal was not simulated.')
	// The governor queues and executes a proposal in single transactions that revert as a whole, so if any planned call fails there is no outcome to show, only the reason.
	const failure = planBlocks.flatMap((block, blockIndex) => block.simulatedTransactions.map((transaction, callIndex) => ({ result: transaction.ethSimulateV1CallResult, call: plan.blocks[blockIndex]?.calls[callIndex] }))).find(({ result }) => result.status === 'failure')
	if (failure !== undefined && failure.result.status === 'failure') return refuse(`${ failure.call?.description ?? 'a call of the execution' } fails (${ failure.result.error.message }), and the governor's transaction reverts as a whole.`)
	const executionResults = executionBlock.simulatedTransactions.map((transaction) => transaction.ethSimulateV1CallResult)
	const executionGas = executionResults.reduce((total, result) => total + result.gasUsed, 0n)
	if (executionGas > parentBlock.gasLimit) return refuse(`executing proposal ${ proposalId } takes ${ executionGas } gas, more than a block's ${ parentBlock.gasLimit }, so the governor's single execution transaction cannot fit in a block.`)
	// A successful execution has to show the timelock executing each action, or it did something other than execute the proposal.
	if (!plan.isProposalExecutedBy(executionResults)) return refuse(`executing proposal ${ proposalId } did not make ${ checksummedAddress(timelock.value.address) } execute its actions.`)
	return {
		success: true,
		simulationState: { ...simulationState, simulationStateInput: simulationState.simulationStateInput.slice(-1), simulatedBlocks: [executionBlock] },
		timelock: timelock.value.address,
		executionTime: bigintSecondsToDate(plan.executionTime),
	}
}
