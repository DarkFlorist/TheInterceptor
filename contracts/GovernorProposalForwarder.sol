// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

interface CompoundTimelock {
	function queueTransaction(address target, uint256 value, string calldata signature, bytes calldata data, uint256 eta) external returns (bytes32);
	function executeTransaction(address target, uint256 value, string calldata signature, bytes calldata data, uint256 eta) external payable returns (bytes memory);
}

// The governance preview places this at a verified governor's address to queue or execute a proposal that is not queued yet at the governor's Compound Timelock in one transaction each, as GovernorBravo's queue and execute do: the timelock sees the governor as the caller of every action. Only the preview's own caller can use these two functions; every other call, such as an action calling back into the governor, runs the governor's own code, which the preview moves to 0x70490ca6DC09Ae17C68377a226527984E1B77b55.
contract GovernorProposalForwarder {
	function queueProposalActions(address timelock, address[] calldata targets, uint256[] calldata values, string[] calldata signatures, bytes[] calldata calldatas, uint256 eta) external {
		require(msg.sender == 0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF, 'GovernorProposalForwarder: only the preview queues');
		for (uint256 index = 0; index < targets.length; index++) {
			CompoundTimelock(timelock).queueTransaction(targets[index], values[index], signatures[index], calldatas[index], eta);
		}
	}

	function executeProposalActions(address timelock, address[] calldata targets, uint256[] calldata values, string[] calldata signatures, bytes[] calldata calldatas, uint256 eta) external {
		require(msg.sender == 0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF, 'GovernorProposalForwarder: only the preview executes');
		for (uint256 index = 0; index < targets.length; index++) {
			CompoundTimelock(timelock).executeTransaction(targets[index], values[index], signatures[index], calldatas[index], eta);
		}
	}

	fallback() external payable {
		assembly {
			calldatacopy(0, 0, calldatasize())
			let success := delegatecall(gas(), 0x70490ca6DC09Ae17C68377a226527984E1B77b55, 0, calldatasize(), 0, 0)
			returndatacopy(0, 0, returndatasize())
			if iszero(success) {
				revert(0, returndatasize())
			}
			return(0, returndatasize())
		}
	}
}
