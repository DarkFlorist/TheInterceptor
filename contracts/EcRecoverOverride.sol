// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

contract EcRecoverOverride {
    mapping(bytes32 => address) private overrideToAddress;

    fallback(bytes calldata input) external returns (bytes memory) {
        (bytes32 hash, uint8 v, bytes32 r, bytes32 s) = abi.decode(input, (bytes32, uint8, bytes32, bytes32));
        address overriddenAddress = overrideToAddress[keccak256(abi.encode(hash, v, r, s))];
        if (overriddenAddress == address(0)) {
            (bool success, bytes memory data) = address(0x0000000000000000000000000000000000123456).call{gas: 10000}(input);
            require(success, 'failed to call moved ecrecover at address 0x0000000000000000000000000000000000123456');
            return data;
        }
        return abi.encode(overriddenAddress);
    }
}
