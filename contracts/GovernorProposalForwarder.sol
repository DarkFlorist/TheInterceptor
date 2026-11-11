// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

interface CompoundTimelock {
	function queueTransaction(address target, uint256 value, string calldata signature, bytes calldata data, uint256 eta) external returns (bytes32);
	function executeTransaction(address target, uint256 value, string calldata signature, bytes calldata data, uint256 eta) external payable returns (bytes memory);
}

// The governance preview places this at a verified governor's address to queue or execute a proposal that is not queued yet at the governor's Compound Timelock in one transaction each, as GovernorBravo's queue and execute do: the timelock sees the governor as the caller of every action. With forwardValues, each action's value goes from the governor to the timelock, as GovernorAlpha's and GovernorBravo's execute forward it; without, the timelock pays from its own balance, as OpenZeppelin's GovernorTimelockCompound has it. Only the preview's own caller can use these two functions; every other call, such as an action calling back into the governor, runs the governor's own code, which the preview moves to 0x70490ca6DC09Ae17C68377a226527984E1B77b55.
contract GovernorProposalForwarder {
	// The governor's balance when it executes does not cover the ether its actions forward. The preview does not supply that ether, which on chain the executor sends with execute.
	error GovernorLacksForwardedEther(uint256 governorBalance, uint256 forwardedValue);

	function queueProposalActions(address timelock, address[] calldata targets, uint256[] calldata values, string[] calldata signatures, bytes[] calldata calldatas, uint256 eta) external {
		require(msg.sender == 0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF, 'GovernorProposalForwarder: only the preview queues');
		for (uint256 index = 0; index < targets.length; index++) {
			CompoundTimelock(timelock).queueTransaction(targets[index], values[index], signatures[index], calldatas[index], eta);
		}
	}

	function executeProposalActions(address timelock, address[] calldata targets, uint256[] calldata values, string[] calldata signatures, bytes[] calldata calldatas, uint256 eta, bool forwardValues) external {
		require(msg.sender == 0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF, 'GovernorProposalForwarder: only the preview executes');
		if (forwardValues) {
			uint256 forwardedValue = 0;
			for (uint256 index = 0; index < values.length; index++) forwardedValue += values[index];
			if (address(this).balance < forwardedValue) revert GovernorLacksForwardedEther(address(this).balance, forwardedValue);
		}
		for (uint256 index = 0; index < targets.length; index++) {
			CompoundTimelock(timelock).executeTransaction{ value: forwardValues ? values[index] : 0 }(targets[index], values[index], signatures[index], calldatas[index], eta);
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
