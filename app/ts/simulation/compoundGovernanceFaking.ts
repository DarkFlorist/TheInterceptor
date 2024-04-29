import { Interface, Result } from 'ethers'
import { EthereumAddress, EthereumData, EthereumQuantity } from '../types/wire-types.js'
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
	const compoundGovernanceAbi = new Interface(governanceContract.abi)

	for (const functionName of requiredFunctions) {
		if (!compoundGovernanceAbi.hasFunction(functionName)) throw new Error(`The governance contract is not currently supported so we are unable to perform the simulation (Additional details to include in a feature request: The contract is missing \`${ functionName }\`).`)
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
	const parentBlock = await ethereumClientService.getBlock(undefined)
	const governanceContractCalls = (await ethereumClientService.simulateTransactionsAndSignatures(calls, [], parentBlock.number, undefined)).calls
	for (const call of governanceContractCalls) {
		if (call.status !== 'success') throw new Error('Failed to retrieve governance contracts information')
	}
	if (governanceContractCalls[0]?.status !== 'success') throw new Error('multicall failed')
	const timeLockContractResult = compoundGovernanceAbi.decodeFunctionResult('timelock', governanceContractCalls[0].returnData)
	const timeLockContract = EthereumAddress.parse(timeLockContractResult[0])
	if (governanceContractCalls[1]?.status !== 'success') throw new Error('proposal simulation call failed')
	const proposal = compoundGovernanceAbi.decodeFunctionResult('proposals', governanceContractCalls[1].returnData)
	const eta: bigint = funtypes.BigInt.parse(proposal.eta)
	if (eta === undefined) throw new Error('eta is undefined')
	if (governanceContractCalls[2]?.status !== 'success') throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = compoundGovernanceAbi.decodeFunctionResult('getActions', governanceContractCalls[2].returnData)
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

export const parseVoteInputParameters = (ethersResult: Result) => {
	if (ethersResult.proposalId === undefined) throw new Error('proposal Id missing from vote call')
	if (ethersResult.support === undefined) throw new Error('support missing from vote call')
	return {
		proposalId: funtypes.BigInt.parse(ethersResult.proposalId),
		support: funtypes.Union(funtypes.Boolean, funtypes.BigInt).parse(ethersResult.support),
		reason: ethersResult.reason !== undefined ? funtypes.String.parse(ethersResult.reason) : undefined,
		params: ethersResult.params !== undefined ? EthereumData.parse(ethersResult.params) : undefined,
		signature: ethersResult.signature !== undefined ? EthereumData.parse(ethersResult.signature) : undefined,
		voter: ethersResult.address !== undefined ? EthereumAddress.parse(ethersResult.address) : undefined,
	}
}
