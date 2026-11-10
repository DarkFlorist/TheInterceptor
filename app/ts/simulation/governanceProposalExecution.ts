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
// A proposal's ProposalCreated event is searched from votingDelay before its snapshot. The governor's current votingDelay can differ from the one the proposal was created with, so the search starts this many blocks earlier.
const PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS = 7200n

// One action of a proposal. Compound-style governors keep the function signature apart from its arguments; for OpenZeppelin governors signature is empty and data is the whole call data.
type ProposalAction = {
	readonly target: bigint
	readonly value: bigint
	readonly signature: string
	readonly data: Hex
}

type GovernorProposal = {
	readonly timelock: bigint
	readonly state: ProposalState
	readonly actions: readonly ProposalAction[]
	// The call to the governor's own execute: by id for Compound-style governors, by actions and description hash for OpenZeppelin governors.
	readonly executeCall: Hex
	readonly eta: bigint | undefined
	readonly votingEndsAt: bigint | undefined
}

type Timelock = { readonly type: 'CompoundTimelock' | 'TimelockController', readonly address: bigint, readonly delay: bigint }

type ExecutionPlan = {
	readonly blocks: readonly { readonly time: bigint, readonly calls: readonly { readonly from: bigint, readonly to: bigint, readonly input: Hex }[] }[]
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

// OpenZeppelin governors without GovernorStorage list a proposal's actions only in the ProposalCreated event they emit when it is proposed.
const findProposalCreatedEvent = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, proposalId: bigint, snapshot: bigint, votingDelay: bigint, clockIsTimestamp: boolean) => {
	const createdAround = snapshot > votingDelay ? snapshot - votingDelay : 0n
	const createdAroundBlock = clockIsTimestamp ? parentBlock.number - (dateToBigintSeconds(parentBlock.timestamp) - createdAround) / SECONDS_PER_BLOCK : createdAround
	const fromBlock = createdAroundBlock > PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS ? createdAroundBlock - PROPOSAL_CREATED_SEARCH_MARGIN_BLOCKS : 0n
	const toBlock = clockIsTimestamp || snapshot > parentBlock.number ? parentBlock.number : snapshot
	const logs = await ethereum.getLogs({ address: governor, fromBlock, toBlock, topics: [PROPOSAL_CREATED_TOPIC] }, undefined)
	const events = logs.flatMap((log) => {
		const decoded = decodeOrUndefined(dataStringWith0xStart(log.data), (data) => decodeEventStrict(GovernorAbi, { data, topics: log.topics.map(bytes32String) }))
		return decoded?.eventName === 'ProposalCreated' && decoded.args.proposalId === proposalId ? [decoded.args] : []
	})
	const [event, ...otherEvents] = events
	if (event === undefined || otherEvents.length > 0) return refuse(`${ checksummedAddress(governor) } does not list the actions of proposal ${ proposalId }, and its ProposalCreated events between blocks ${ fromBlock } and ${ toBlock } do not name the proposal exactly once.`)
	return accept(event)
}

const readGovernorProposal = async (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, governor: bigint, proposalId: bigint): Promise<Checked<GovernorProposal>> => {
	const readGovernor = (input: Hex) => ({ to: governor, input })
	const [timelockReply, stateReply, actionsReply, proposalsReply, detailsReply, etaReply, deadlineReply, snapshotReply, votingDelayReply, clockModeReply] = await readContracts(ethereum, parentBlock, [
		readGovernor(encodeFunctionCall(GovernorAbi, 'timelock', [])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'state', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'getActions', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'proposals', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'proposalDetails', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'proposalEta', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'proposalDeadline', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'proposalSnapshot', [proposalId])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'votingDelay', [])),
		readGovernor(encodeFunctionCall(GovernorAbi, 'CLOCK_MODE', [])),
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
	const votingEndsAt = isCompoundProposal ? estimateTimeOfBlock(parentBlock, endBlock) : openZeppelinVotingEndsAt
	const eta = isCompoundProposal ? compoundEta : decodeOrUndefined(etaReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalEta', reply))
	const differentLengths = refuse(`${ checksummedAddress(governor) } lists actions of different lengths for proposal ${ proposalId }.`)

	const compoundActions = decodeOrUndefined(actionsReply, (reply) => decodeFunctionOutput(GovernorAbi, 'getActions', reply))
	if (compoundActions !== undefined) {
		const [targets, values, signatures, calldatas] = compoundActions
		if (values.length !== targets.length || signatures.length !== targets.length || calldatas.length !== targets.length) return differentLengths
		const actions = targets.map((target, index) => ({ target: BigInt(target), value: values[index] ?? 0n, signature: signatures[index] ?? '', data: calldatas[index] ?? '0x' }))
		return accept({ timelock: BigInt(timelock), state, actions, executeCall: encodeFunctionCall(GovernorAbi, 'execute', [proposalId]), eta, votingEndsAt })
	}

	const getOpenZeppelinActions = async () => {
		const details = decodeOrUndefined(detailsReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalDetails', reply))
		if (details !== undefined) return accept({ targets: details[0], values: details[1], calldatas: details[2], descriptionHash: details[3] })
		const snapshot = decodeOrUndefined(snapshotReply, (reply) => decodeFunctionOutput(GovernorAbi, 'proposalSnapshot', reply))
		const votingDelay = decodeOrUndefined(votingDelayReply, (reply) => decodeFunctionOutput(GovernorAbi, 'votingDelay', reply))
		if (snapshot === undefined || votingDelay === undefined) return refuse(`${ checksummedAddress(governor) } does not list the actions of proposal ${ proposalId } through getActions, proposalDetails or its ProposalCreated event.`)
		const event = await findProposalCreatedEvent(ethereum, parentBlock, governor, proposalId, snapshot, votingDelay, clockIsTimestamp)
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
	return accept({ timelock: BigInt(timelock), state, actions, executeCall: encodeFunctionCall(GovernorAbi, 'execute', [targets, values, calldatas, descriptionHash]), eta, votingEndsAt })
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
const planQueueAndExecution = (stackEndTime: bigint, governor: bigint, proposalId: bigint, proposal: GovernorProposal, timelock: Timelock): ExecutionPlan => {
	const earliestQueueTime = stackEndTime + MINIMUM_SECONDS_UNTIL_QUEUE
	const queueTime = proposal.votingEndsAt !== undefined && proposal.votingEndsAt + 1n > earliestQueueTime ? proposal.votingEndsAt + 1n : earliestQueueTime
	const executionTime = queueTime + timelock.delay
	const fromGovernor = (input: Hex) => ({ from: governor, to: timelock.address, input })
	const isProposalExecutedBy = isExecutedByTimelock(timelock, proposal.actions, executionTime)
	if (timelock.type === 'CompoundTimelock') {
		const transactionArguments = (action: ProposalAction) => [addressString(action.target), action.value, action.signature, action.data, executionTime] as const
		return {
			blocks: [
				{ time: queueTime, calls: proposal.actions.map((action) => fromGovernor(encodeFunctionCall(CompoundTimelockAbi, 'queueTransaction', transactionArguments(action)))) },
				{ time: executionTime, calls: proposal.actions.map((action) => fromGovernor(encodeFunctionCall(CompoundTimelockAbi, 'executeTransaction', transactionArguments(action)))) },
			],
			executionTime,
			isProposalExecutedBy,
		}
	}
	// The proposal id as salt keeps the simulated operation apart from any operation already scheduled at the timelock.
	const batch = [proposal.actions.map((action) => addressString(action.target)), proposal.actions.map((action) => action.value), proposal.actions.map(callDataOf), ZERO_BYTES32, bytes32String(proposalId)] as const
	return {
		blocks: [
			{ time: queueTime, calls: [fromGovernor(encodeFunctionCall(TimelockControllerAbi, 'scheduleBatch', [...batch, timelock.delay]))] },
			{ time: executionTime, calls: [fromGovernor(encodeFunctionCall(TimelockControllerAbi, 'executeBatch', batch))] },
		],
		executionTime,
		isProposalExecutedBy,
	}
}

// Plans the proposal's execution after the simulation stack, whose last block is at stackEndTime.
const planExecution = (stackEndTime: bigint, governor: bigint, proposalId: bigint, proposal: GovernorProposal, timelock: Timelock): Checked<ExecutionPlan> => {
	switch (proposal.state) {
		case 'Pending':
		case 'Active':
		case 'Succeeded': return accept(planQueueAndExecution(stackEndTime, governor, proposalId, proposal, timelock))
		case 'Queued': {
			if (proposal.eta === undefined || proposal.eta === 0n) return refuse(`proposal ${ proposalId } is queued, but ${ checksummedAddress(governor) } does not report when it can be executed.`)
			// A queued proposal is executed as anyone can execute it: through the governor's execute, once its eta has passed.
			const earliestTime = stackEndTime + SECONDS_PER_BLOCK
			const executionTime = proposal.eta > earliestTime ? proposal.eta : earliestTime
			return accept({
				blocks: [{ time: executionTime, calls: [{ from: MOCK_ADDRESS, to: governor, input: proposal.executeCall }] }],
				executionTime,
				isProposalExecutedBy: isExecutedByTimelock(timelock, proposal.actions, proposal.eta),
			})
		}
		case 'Canceled':
		case 'Defeated':
		case 'Expired':
		case 'Executed': return refuse(`proposal ${ proposalId } is ${ proposal.state.toLowerCase() }, so it will not be executed.`)
	}
}

const toSimulationInputBlocks = (ethereum: EthereumClientService, parentBlock: EthereumBlockHeader, plan: ExecutionPlan, website: Website): SimulationStateInput => plan.blocks.map((block): SimulationStateInputBlock => {
	// The calls of a block share its gas, so the node runs all of them in that one block, at that block's time.
	const gas = parentBlock.gasLimit / BigInt(block.calls.length)
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
 * Simulates what executing a governance proposal does, as the governor's own timelock executes it, after the simulation stack. The governor, its timelock and the proposal are read from the chain's latest block, and the execution runs through the real governor and timelock code with no state overrides, so the outcome contains only what those contracts would do.
 * The governor has to be a Compound-style or OpenZeppelin governor whose timelock() is a Compound Timelock or an OpenZeppelin TimelockController that accepts it. Anything else, and any proposal that will not be executed, gets a reason instead of an outcome.
 * stackSimulationInput has to be prepared for the node already (prepareSafeExecutionsForRpc).
 */
export const simulateGovernanceProposalExecution = async (ethereum: EthereumClientService, stackSimulationInput: SimulationStateInput, governor: bigint, proposalId: bigint, website: Website): Promise<GovernanceExecutionPreview> => {
	const parentBlock = await ethereum.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	const proposal = await readGovernorProposal(ethereum, parentBlock, governor, proposalId)
	if (!proposal.success) return proposal
	if (proposal.value.actions.length === 0) return refuse(`proposal ${ proposalId } has no actions.`)
	const timelock = await identifyTimelock(ethereum, parentBlock, governor, proposal.value.timelock)
	if (!timelock.success) return timelock
	const stackEndTime = dateToBigintSeconds(stackSimulationInput.reduce((previousTime, block) => getNextBlockTimeStampOverride(previousTime, block.blockTimeManipulation), parentBlock.timestamp))
	const plan = planExecution(stackEndTime, governor, proposalId, proposal.value, timelock.value)
	if (!plan.success) return plan
	const simulationState = await createSimulationState(ethereum, undefined, [...stackSimulationInput, ...toSimulationInputBlocks(ethereum, parentBlock, plan.value, website)])
	if (simulationState.success === false) throw new Error(simulationState.jsonRpcError.error.message)
	const executionBlock = simulationState.simulatedBlocks[simulationState.simulatedBlocks.length - 1]
	if (executionBlock === undefined) throw new Error('The execution of the proposal was not simulated.')
	const executionResults = executionBlock.simulatedTransactions.map((transaction) => transaction.ethSimulateV1CallResult)
	// A reverting execution is shown as it is. One that succeeds has to show the timelock executing each action, or it did something other than execute the proposal.
	if (executionResults.every((result) => result.status === 'success') && !plan.value.isProposalExecutedBy(executionResults)) return refuse(`executing proposal ${ proposalId } did not make ${ checksummedAddress(timelock.value.address) } execute its actions.`)
	return {
		success: true,
		simulationState: { ...simulationState, simulationStateInput: simulationState.simulationStateInput.slice(-1), simulatedBlocks: [executionBlock] },
		timelock: timelock.value.address,
		executionTime: bigintSecondsToDate(plan.value.executionTime),
	}
}
