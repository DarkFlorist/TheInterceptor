// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

// Modified from SafeProxy.sol in safe-global/safe-smart-account.
contract GnosisSafeProxyProxy {
	function delegateCallExecute(address target, bytes memory callData) external payable returns (bytes memory) {
		(bool success, bytes memory returnData) = payable(target).delegatecall(callData);
		require(success, 'Delegate call failed');
		return returnData;
	}

	/// Forwards all transactions to 0x0000000000000000000000000000000000920515.
	fallback() external payable {
		assembly {
			let originalGnosisSafeProxy := 0x0000000000000000000000000000000000920515
			calldatacopy(0, 0, calldatasize())
			let success := delegatecall(gas(), originalGnosisSafeProxy, 0, calldatasize(), 0, 0)
			returndatacopy(0, 0, returndatasize())
			if iszero(success) {
				revert(0, returndatasize())
			}
			return(0, returndatasize())
		}
	}
}
