# Gnosis Safe wallet capability

This uses the standard `wallet_getCapabilities` RPC method. `gnosisSafeExecution` is an Interceptor-specific capability name within that standard response; it does not add an Interceptor-specific RPC method.

Interceptor exposes its connected Gnosis Safe execution support through `wallet_getCapabilities`. The RPC method follows ERC-5792 capability discovery, while the `gnosisSafeExecution` capability described here is an Interceptor extension rather than a standardized ERC capability.

## Request

The first parameter is the Gnosis Safe address. The optional second parameter limits discovery to particular chain IDs.

```json
{
  "method": "wallet_getCapabilities",
  "params": [
    "0x1234567890123456789012345678901234567890",
    ["0x1"]
  ]
}
```

Interceptor returns an authorization error when the requested address is not the active account. It returns an empty object when Gnosis Safe execution is unavailable or the active chain was not requested.

## Response

Capabilities are keyed by canonical hexadecimal chain ID:

```json
{
  "0x1": {
    "gnosisSafeExecution": {
      "supported": true,
      "version": "1.0.0",
      "activeSigner": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "submissionMethod": "eth_sendTransaction"
    }
  }
}
```

- `activeSigner` is the EOA configured to sign or submit transactions for the active Gnosis Safe.
- `submissionMethod` identifies the RPC method a site should use for execution.
- Capability discovery does not request a signature, execute a transaction, or grant additional account access.

## Execution contract

After discovering the capability, a site submits the Gnosis Safe `execTransaction` call with `eth_sendTransaction`. Both `from` and `to` must be the active Gnosis Safe address, and the outer transaction value must be zero. Any ETH transferred by the Gnosis Safe is encoded inside `execTransaction`.

Interceptor validates the call, completes the approved Gnosis Safe signature set when the configured signer can do so, changes the outer transaction sender to the configured EOA, simulates the result, and presents it for approval. A site should use its ordinary EOA signing and execution flow when `gnosisSafeExecution` is absent.
