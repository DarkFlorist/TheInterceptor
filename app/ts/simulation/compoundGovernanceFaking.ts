import { Interface } from 'ethers'
import { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'
import { CompoundTimeLock } from '../utils/abi.js'
import { addressString, checksummedAddress, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { getCompoundGovernanceTimeLockMulticall } from '../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../types/addressBookTypes.js'

export const simulateCompoundGovernanceExecution = async (ethereumClientService: EthereumClientService, governanceContract: AddressBookEntry, proposalId: EthereumQuantity) => {
	const compoundTimeLockAbi = new Interface(CompoundTimeLock)
	if (!('abi' in governanceContract) || governanceContract.abi === undefined) throw new Error(`We need to have ABI for governance contract ${ checksummedAddress(governanceContract.address) } to be able to proceed :()`)
	const requiredFunctions = ['timelock', 'proposals', 'getActions']
	requiredFunctions.forEach((func) => {
		if (!compoundGovernanceAbi.hasFunction(func)) throw new Error(`Unable to perform simulation: The contract is missing "${ func }" function.`)
	})

	const compoundGovernanceAbi = new Interface(governanceContract.abi)
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
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('timelock', [])),
		},
		{ // get proposals
			...txBase,
			gas: 90000n,
			to: governanceContract.address,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('proposals', [EthereumQuantity.serialize(proposalId)])),
		},
		{ // get actions
			...txBase,
			gas: 90000n,
			to: governanceContract.address,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('getActions', [EthereumQuantity.serialize(proposalId)])),
		}
	]
	const parentBlock = await ethereumClientService.getBlock()
	const governanceContractCalls = await ethereumClientService.multicall(calls, [], parentBlock.number)
	governanceContractCalls.forEach((call) => { if (call.statusCode !== 'success') throw new Error('Failed to retrieve governance contracts information') })
	if (governanceContractCalls[0]?.returnValue === undefined) return undefined
	const timeLockContractResult = compoundGovernanceAbi.decodeFunctionResult('timelock', governanceContractCalls[0].returnValue)
	const timeLockContract = EthereumAddress.parse(timeLockContractResult[0])
	if (governanceContractCalls[1] === undefined) throw new Error('proposals return value was undefined')
	const proposal = compoundGovernanceAbi.decodeFunctionResult('proposals', governanceContractCalls[1].returnValue)
	const eta: bigint = funtypes.BigInt.parse(proposal[0].eta)
	if (eta === undefined) throw new Error('eta is undefined')
	
	if (governanceContractCalls[2] === undefined) throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = compoundGovernanceAbi.decodeFunctionResult('getActions', governanceContractCalls[2].returnValue)
	const executingTransaction = {
		...txBase,
		from: governanceContract.address,
		to: timeLockContract,
		input: stringToUint8Array(compoundTimeLockAbi.encodeFunctionData('executeTransactions', [targets, values, signatures, calldatas, eta])),
	}

	if (eta >= parentBlock.timestamp.getTime()) throw new Error('ETA has passed already')
	
	const query = [{
		calls: [executingTransaction],
		blockOverride: {
			number: parentBlock.number + 1n,
			prevRandao: 0x1n,
			time: new Date(Number(eta) * 1000), // timestamp is set to ETA
			gasLimit: parentBlock.gasLimit,
			feeRecipient: parentBlock.miner,
			baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
		},
		stateOverrides: {
			[addressString(timeLockContract)]: { code: getCompoundGovernanceTimeLockMulticall(), stateDiff: {} }
		},
	}]
	const singleMulticalResult = (await ethereumClientService.executionSpec383MultiCall(query, parentBlock.number))[0]
	if (singleMulticalResult === undefined) throw new Error('multicallResult was undefined')
	const multicallResult = (ethereumClientService.convertExecutionSpec383MulticallToOldMulticall(singleMulticalResult))[0]
	if (multicallResult === undefined) throw new Error('multicallResult did not exist')
	return { multicallResult, executingTransaction }
}
