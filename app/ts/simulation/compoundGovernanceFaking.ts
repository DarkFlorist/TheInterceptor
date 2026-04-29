import { EthereumAddress, EthereumData, EthereumQuantity } from '../types/wire-types.js'
import { CompoundTimeLock } from '../utils/abi.js'
import { addressString, bigintSecondsToDate, checksummedAddress, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { getCompoundGovernanceTimeLockMulticall } from '../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { DEFAULT_BLOCK_MANIPULATION, mockSignTransaction } from './services/SimulationModeEthereumClientService.js'
import { decodeFunctionOutputLoose, decodeFunctionOutputObjectLoose, encodeFunctionCallLoose, hasFunctionLoose } from '../utils/abiRuntime.js'

export const simulateCompoundGovernanceExecution = async (ethereumClientService: EthereumClientService, governanceContract: AddressBookEntry, proposalId: EthereumQuantity) => {
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
	const input = [ {
		stateOverrides: {},
		transactions: calls.map((call) => ({ signedTransaction: mockSignTransaction(call) })),
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee: true,
	} ] as const

	const governanceContractCalls = (await ethereumClientService.simulate(input, parentBlock.number, undefined))[0]?.calls
	if (governanceContractCalls === undefined) throw new Error('simulateTransactionsAndSignatures returned zero length aray')
	for (const call of governanceContractCalls) {
		if (call.status !== 'success') throw new Error('Failed to retrieve governance contracts information')
	}
	if (governanceContractCalls[0]?.status !== 'success') throw new Error('multicall failed')
	const [timeLockContractResult] = decodeFunctionOutputLoose(governanceContract.abi, 'timelock', governanceContractCalls[0].returnData)
	const timeLockContract = EthereumAddress.parse(funtypes.String.parse(timeLockContractResult))
	if (governanceContractCalls[1]?.status !== 'success') throw new Error('proposal simulation call failed')
	const proposal = decodeFunctionOutputObjectLoose(governanceContract.abi, 'proposals', governanceContractCalls[1].returnData)
	const eta: bigint = funtypes.BigInt.parse(proposal['eta'])
	if (eta === undefined) throw new Error('eta is undefined')
	if (governanceContractCalls[2]?.status !== 'success') throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = decodeFunctionOutputLoose(governanceContract.abi, 'getActions', governanceContractCalls[2].returnData)
	const executingTransaction = {
		...txBase,
		from: governanceContract.address,
		to: timeLockContract,
		input: stringToUint8Array(encodeFunctionCallLoose(CompoundTimeLock, 'executeTransactions', [targets, values, signatures, calldatas, eta])),
	}

	if (eta >= parentBlock.timestamp.getTime()) throw new Error('ETA has passed already')
	const query = [{
		calls: [executingTransaction],
		blockOverrides: {
			prevRandao: 0x1n,
			time: bigintSecondsToDate(eta), // timestamp is set to ETA
			gasLimit: parentBlock.gasLimit,
			feeRecipient: parentBlock.miner,
			baseFeePerGas: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
		},
		stateOverrides: {
			[addressString(timeLockContract)]: { code: getCompoundGovernanceTimeLockMulticall(), stateDiff: {} }
		},
	}]
	const ethSimulateV1CallResult = (await ethereumClientService.ethSimulateV1(query, parentBlock.number, undefined))[0]?.calls[0]
	if (ethSimulateV1CallResult === undefined) throw new Error('ethSimulateV1 result was undefined')
	return { ethSimulateV1CallResult, executingTransaction }
}

export const parseVoteInputParameters = (args: Record<string, unknown>) => {
	if (args['proposalId'] === undefined) throw new Error('proposal Id missing from vote call')
	if (args['support'] === undefined) throw new Error('support missing from vote call')
	return {
		proposalId: funtypes.BigInt.parse(args['proposalId']),
		support: funtypes.Union(funtypes.Boolean, funtypes.BigInt).parse(args['support']),
		reason: args['reason'] !== undefined ? funtypes.String.parse(args['reason']) : undefined,
		params: args['params'] !== undefined ? EthereumData.parse(args['params']) : undefined,
		signature: args['signature'] !== undefined ? EthereumData.parse(args['signature']) : undefined,
		voter: args['address'] !== undefined ? EthereumAddress.parse(args['address']) : undefined,
	}
}
