// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

contract StorageReader {
	function readSlot(bytes32 slot) external view returns (bytes32 value) {
		assembly {
			value := sload(slot)
		}
	}
}
