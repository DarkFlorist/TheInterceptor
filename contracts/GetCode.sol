// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

library GetCode {
    function at(address target) public view returns (bytes memory code) {
        assembly {
            let size := extcodesize(target)
            code := mload(0x40)
            mstore(0x40, add(code, and(add(add(size, 0x20), 0x1f), not(0x1f))))
            mstore(code, size)
            extcodecopy(target, add(code, 0x20), 0, size)
        }
    }
}
