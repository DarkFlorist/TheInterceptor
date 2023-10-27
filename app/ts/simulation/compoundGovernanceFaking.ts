import { Interface } from 'ethers'
import { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'
import { CompoundGovernanceAbi, CompoundTimeLock } from '../utils/abi.js'
import { addressString, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { getCompoundGovernanceTimeLockMulticall } from '../utils/ethereumByteCodes.js'

export const simulateCompoundGovernanceExecution = async (ethereumClientService: EthereumClientService, governanceContract: EthereumAddress, proposalId: EthereumQuantity) => {
	const compoundGovernanceAbi = new Interface(CompoundGovernanceAbi)
	const compoundTimeLockAbi = new Interface(CompoundTimeLock)
	const parentBlock = await ethereumClientService.getBlock()
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
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('timelock', [])),
		},
		{ // get proposals
			...txBase,
			gas: 90000n,
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('proposals', [EthereumQuantity.serialize(proposalId)])),
		},
		{ // get actions
			...txBase,
			gas: 90000n,
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('getActions', [EthereumQuantity.serialize(proposalId)])),
		}
	]
	const governanceContractCalls = await ethereumClientService.multicall(calls, [], parentBlock.number)
	if (governanceContractCalls[0]?.returnValue === undefined) return undefined
	const timeLockContractResult = compoundGovernanceAbi.decodeFunctionResult('timelock', governanceContractCalls[0].returnValue)
	const timeLockContract = EthereumAddress.parse(timeLockContractResult[0])
	if (governanceContractCalls[1] === undefined) throw new Error('proposals return value was undefined')
	const [_id, _proposer, eta, _startBlock, _endBlock, _forVotes, _againstVotes, _abstainVotes, canceled, executed] = compoundGovernanceAbi.decodeFunctionResult('proposals', governanceContractCalls[1].returnValue)
	
	if (governanceContractCalls[2] === undefined) throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = compoundGovernanceAbi.decodeFunctionResult('getActions', governanceContractCalls[2].returnValue)

	if (canceled || executed) throw new Error('Canceled or Executed already')

	const executeTx = {
		...txBase,
		from: timeLockContract,
		to: timeLockContract,
		input: stringToUint8Array(compoundTimeLockAbi.encodeFunctionData('executeTransactions', [targets, values, signatures, calldatas, eta])),
	}

	if (eta >= parentBlock.timestamp.getTime()) throw new Error('ETA has passed already')
	
	const query = [{
		calls: [executeTx],
		blockOverride: {
			number: parentBlock.number + 1n,
			prevRandao: 0x1n,
			time: new Date(Number.parseInt(eta) * 1000), // timestamp is set to ETA
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
	return ethereumClientService.convertExecutionSpec383MulticallToOldMulticall(singleMulticalResult)
}
