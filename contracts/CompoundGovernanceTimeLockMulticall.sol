// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

contract CompoundGovernanceTimeLockMulticall {
	event ExecuteTransaction(bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta);

	function executeTransactions(
		address[] memory targets,
		uint256[] memory values,
		string[] memory signatures,
		bytes[] memory datas,
		uint256 eta
	) public payable {
		for (uint256 i = 0; i < targets.length; i++) {
			this.executeTransaction(targets[i], values[i], signatures[i], datas[i], eta);
		}
	}

	function executeTransaction(
		address target,
		uint256 value,
		string memory signature,
		bytes memory data,
		uint256 eta
	) public payable returns (bytes memory) {
		bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
		bytes memory callData;
		if (bytes(signature).length == 0) {
			callData = data;
		} else {
			callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
		}

		(bool success, bytes memory returnData) = target.call{value: value}(callData);
		require(success, 'Timelock::executeTransaction: Transaction execution reverted.');

		emit ExecuteTransaction(txHash, target, value, signature, data, eta);
		return returnData;
	}
}
