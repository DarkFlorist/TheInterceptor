import { EthereumAddress, EthereumData, EthereumQuantity } from '../types/wire-types.js'
import { CompoundTimeLock } from '../utils/abi.js'
import { addressString, bigintSecondsToDate, checksummedAddress, dateToBigintSeconds, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { getCompoundGovernanceTimeLockMulticall } from '../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import { mockSignTransaction } from './services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import { decodeFunctionOutputLoose, decodeFunctionOutputObjectLoose, encodeFunctionCallLoose, hasFunctionLoose } from '../utils/abiRuntime.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import { mergeStateOverrides } from '../utils/simulationStateOverrides.js'
import type { PreSimulationTransaction, SimulationInput, SimulationStateInput } from '../types/visualizer-types.js'

export const getGovernanceExecutionSimulationInput = (
	simulationInput: SimulationStateInput,
	executionTransaction: PreSimulationTransaction,
	executionTimestamp: Date,
	executionStateOverrides: StateOverrides,
): SimulationStateInput => [
	...simulationInput,
	{
		stateOverrides: executionStateOverrides,
		transactions: [executionTransaction],
		signedMessages: [],
		blockTimeManipulation: { type: 'SetTimetamp', timeToSet: dateToBigintSeconds(executionTimestamp) },
		simulateWithZeroBaseFee: false,
	},
]

export const simulateCompoundGovernanceExecution = async (
	ethereumClientService: EthereumClientService,
	governanceContract: AddressBookEntry,
	proposalId: EthereumQuantity,
	simulationInput: SimulationInput,
	executionTransactionMetadata: Omit<PreSimulationTransaction, 'signedTransaction'>,
) => {
	if (!('abi' in governanceContract) || governanceContract.abi === undefined) throw new Error(`We need to have ABI for governance contract ${ checksummedAddress(governanceContract.address) } to be able to proceed :()`)
	const requiredFunctions = ['timelock', 'proposals', 'getActions']

	for (const functionName of requiredFunctions) {
		if (!hasFunctionLoose(governanceContract.abi, functionName)) throw new Error(`The governance contract is not currently supported so we are unable to perform the simulation (Additional details to include in a feature request: The contract is missing \`${ functionName }\`).`)
	}

	const txBase = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		value: 0n,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		accessList: [],
		chainId: ethereumClientService.getChainId(),
		nonce: 0n,
	}

	const calls = [
		{ // get timelock
			...txBase,
			gas: 30000n,
			to: governanceContract.address,
			input: stringToUint8Array(encodeFunctionCallLoose(governanceContract.abi, 'timelock', [])),
		},
		{ // get proposals
			...txBase,
			gas: 90000n,
			to: governanceContract.address,
			input: stringToUint8Array(encodeFunctionCallLoose(governanceContract.abi, 'proposals', [EthereumQuantity.serialize(proposalId)])),
		},
		{ // get actions
			...txBase,
			gas: 90000n,
			to: governanceContract.address,
			input: stringToUint8Array(encodeFunctionCallLoose(governanceContract.abi, 'getActions', [EthereumQuantity.serialize(proposalId)])),
		}
	]
	const parentBlock = await ethereumClientService.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	const readBlock = {
		stateOverrides: {},
		transactions: calls.map((call) => ({ signedTransaction: mockSignTransaction(call) })),
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee: true,
	} as const

	const readInput = { ...simulationInput, value: [...simulationInput.value, readBlock] }
	const readResults = await ethereumClientService.simulate(readInput, parentBlock.number, undefined)
	const governanceContractCalls = readResults[readResults.length - 1]?.calls
	if (governanceContractCalls === undefined) throw new Error('simulateTransactionsAndSignatures returned zero length aray')
	for (const call of governanceContractCalls) {
		if (call.status !== 'success') throw new Error('Failed to retrieve governance contracts information')
	}
	if (governanceContractCalls[0]?.status !== 'success') throw new Error('multicall failed')
	const [timeLockContractResult] = decodeFunctionOutputLoose(governanceContract.abi, 'timelock', governanceContractCalls[0].returnData)
	const timeLockContract = EthereumAddress.parse(funtypes.String.parse(timeLockContractResult))
	if (governanceContractCalls[1]?.status !== 'success') throw new Error('proposal simulation call failed')
	const proposal = decodeFunctionOutputObjectLoose(governanceContract.abi, 'proposals', governanceContractCalls[1].returnData)
	const { eta: rawEta } = proposal
	const eta: bigint = funtypes.BigInt.parse(rawEta)
	if (eta === undefined) throw new Error('eta is undefined')
	if (governanceContractCalls[2]?.status !== 'success') throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = decodeFunctionOutputLoose(governanceContract.abi, 'getActions', governanceContractCalls[2].returnData)
	const executingTransaction = {
		...txBase,
		from: governanceContract.address,
		to: timeLockContract,
		input: stringToUint8Array(encodeFunctionCallLoose(CompoundTimeLock, 'executeTransactions', [targets, values, signatures, calldatas, eta])),
	}

	if (eta <= dateToBigintSeconds(parentBlock.timestamp)) throw new Error('ETA has passed already')
	const timeLockOverrides: StateOverrides = {
		[addressString(timeLockContract)]: { code: getCompoundGovernanceTimeLockMulticall(), stateDiff: {} }
	}
	const executionTimestamp = bigintSecondsToDate(eta)
	const executionInput = getGovernanceExecutionSimulationInput(simulationInput.value, {
		...executionTransactionMetadata,
		signedTransaction: mockSignTransaction({ ...executingTransaction, gas: parentBlock.gasLimit }),
	}, executionTimestamp, timeLockOverrides)
	// The shim wins if it shares an address with initial state in an otherwise empty stack.
	const executionOverrides = simulationInput.value.length === 0
		? mergeStateOverrides(simulationInput.simulationOverrides, timeLockOverrides)
		: simulationInput.simulationOverrides
	const executionResults = await ethereumClientService.simulate({ ...simulationInput, value: executionInput, simulationOverrides: executionOverrides }, parentBlock.number, undefined)
	const ethSimulateV1CallResult = executionResults[executionResults.length - 1]?.calls[0]
	if (ethSimulateV1CallResult === undefined) throw new Error('ethSimulateV1 result was undefined')
	return {
		ethSimulateV1CallResult,
		executingTransaction,
		executionGasLimit: parentBlock.gasLimit,
		executionTimestamp,
		executionStateOverrides: timeLockOverrides,
		executionSimulationOverrides: executionOverrides,
	}
}

export const parseVoteInputParameters = (args: Record<string, unknown>) => {
	const {
		proposalId: rawProposalId,
		support: rawSupport,
		reason: rawReason,
		params: rawParams,
		signature: rawSignature,
		address: rawAddress,
	} = args
	if (rawProposalId === undefined) throw new Error('proposal Id missing from vote call')
	if (rawSupport === undefined) throw new Error('support missing from vote call')
	return {
		proposalId: funtypes.BigInt.parse(rawProposalId),
		support: funtypes.Union(funtypes.Boolean, funtypes.BigInt).parse(rawSupport),
		reason: rawReason !== undefined ? funtypes.String.parse(rawReason) : undefined,
		params: rawParams !== undefined ? EthereumData.parse(rawParams) : undefined,
		signature: rawSignature !== undefined ? EthereumData.parse(rawSignature) : undefined,
		voter: rawAddress !== undefined ? EthereumAddress.parse(rawAddress) : undefined,
	}
}
