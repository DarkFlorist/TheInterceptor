/*

// governor
function execute(uint proposalId) external {
    require(state(proposalId) == ProposalState.Queued, "GovernorBravo::execute: proposal can only be executed if it is queued");
    Proposal storage proposal = proposals[proposalId];
    proposal.executed = true;
    for (uint i = 0; i < proposal.targets.length; i++) {
        timelock.executeTransaction(proposal.targets[i], proposal.values[i], proposal.signatures[i], proposal.calldatas[i], proposal.eta);
    }
    emit ProposalExecuted(proposalId);
}

//timelock:
function executeTransaction(address target, uint value, string memory signature, bytes memory data, uint eta) public payable returns (bytes memory) {
    require(msg.sender == admin, "Timelock::executeTransaction: Call must come from admin.");

    bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
    require(queuedTransactions[txHash], "Timelock::executeTransaction: Transaction hasn't been queued.");
    require(getBlockTimestamp() >= eta, "Timelock::executeTransaction: Transaction hasn't surpassed time lock.");
    require(getBlockTimestamp() <= eta.add(GRACE_PERIOD), "Timelock::executeTransaction: Transaction is stale.");

    queuedTransactions[txHash] = false;

    bytes memory callData;

    if (bytes(signature).length == 0) {
        callData = data;
    } else {
        callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
    }

    // solium-disable-next-line security/no-call-value
    (bool success, bytes memory returnData) = target.call.value(value)(callData);
    require(success, "Timelock::executeTransaction: Transaction execution reverted.");

    emit ExecuteTransaction(txHash, target, value, signature, data, eta);

    return returnData;
}

*/

import { ethers } from 'ethers'
import { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'
import { CompoundGovernanceAbi, CompoundTimeLock } from '../utils/abi.js'
import { addressString, stringToUint8Array } from '../utils/bigint.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { getCompoundGovernanceTimeLockMulticall } from '../utils/ethereumByteCodes.js'

export const simulateCompoundGovernanceExecution = async (ethereumClientService: EthereumClientService, governanceContract: EthereumAddress, proposalId: EthereumQuantity) => {
	const compoundGovernanceAbi = new ethers.Interface(CompoundGovernanceAbi)
	const compoundTimeLockAbi = new ethers.Interface(CompoundTimeLock)
	const parentBlock = await ethereumClientService.getBlock()
	const txBase = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		value: 0n,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		accessList: [],
		gas: 42000n,
		chainId: ethereumClientService.getChainId(),
		nonce: 0n,
	}
	const governanceContractCalls = await ethereumClientService.multicall([
		{ // get timelock
			...txBase,
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('timelock')),
		},
		{ // get proposals
			...txBase,
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('proposals', [EthereumQuantity.serialize(proposalId)])),
		},
		{ // get actions
			...txBase,
			to: governanceContract,
			input: stringToUint8Array(compoundGovernanceAbi.encodeFunctionData('getActions', [EthereumQuantity.serialize(proposalId)])),
		}
	], [], parentBlock.number)

	const timeLockContract = EthereumAddress.parse(governanceContractCalls[0]?.returnValue)
	if (governanceContractCalls[1] === undefined) throw new Error('proposals return value was undefined')
	const [_id, _proposer, eta, _startBlock, _endBlock, _forVotes, _againstVotes, _abstainVotes, canceled, executed] = compoundGovernanceAbi.decodeFunctionResult('proposals', governanceContractCalls[1].returnValue)
	if (governanceContractCalls[2] === undefined) throw new Error('getActions return value was undefined')
	const [targets, values, signatures, calldatas] = compoundGovernanceAbi.decodeFunctionResult('getActions', governanceContractCalls[1].returnValue)

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
			time: eta, // timestamp is set to ETA
			gasLimit: parentBlock.gasLimit,
			feeRecipient: parentBlock.miner,
			baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
		},
		stateOverrides: {
			[addressString(timeLockContract)]: { code: getCompoundGovernanceTimeLockMulticall(), stateDiff: {} }
		},
	}]
	return await ethereumClientService.executionSpec383MultiCall(query, parentBlock.number)
}
