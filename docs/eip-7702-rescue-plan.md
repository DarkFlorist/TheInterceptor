# EIP-7702 Delegation Rescue Plan

## Recommended Rescue Flow

Build the first rescue path around a sponsored type-4 transaction and the existing Bouquet private bundle flow.

1. Detect that the compromised account currently has EIP-7702 delegation code.
2. Have the compromised account sign an EIP-7702 authorization whose delegate address is `0x0000000000000000000000000000000000000000`.
3. Have a separate funded sponsor account submit a type-4 transaction containing that authorization list.
4. Put the sponsored clear-delegation transaction first in a private Bouquet bundle.
5. Put the normal funding transaction and victim-signed token rescue transfers after it in the same bundle.
6. Optionally drain leftover ETH from the compromised account at the end of the bundle.

This avoids sending ETH to a delegated compromised account before the hostile delegation is removed. The sponsored type-4 transaction pays gas from the sponsor while changing the compromised account's delegation, and the private bundle keeps the later funding and sweep transactions from being exposed independently.

## Interceptor Feature Plan

Interceptor should be able to inspect, simulate, and export the rescue bundle components. It should not be responsible for holding private keys or submitting bundles.

Required Interceptor features:

1. Accept EIP-7702 `authorizationList` values on `eth_sendTransaction` requests.
2. Preserve authorization list delegate targets when building simulated type-4 transactions.
3. Support serialized type-4 transactions passed through `eth_sendRawTransaction`.
4. Recover the type-4 transaction sender from raw transactions for simulation stack bookkeeping.
5. Recover authorization authority addresses from signed authorizations when available, so sponsored transactions can show the compromised account separately from the sponsor.
6. Include 7702 transaction data in simulation stack exports so Bouquet can import and plan around it.
7. Continue showing already-delegated senders detected from `eth_getCode` as a separate signal from newly included authorization lists.

Out of scope for Interceptor:

1. Signing victim authorizations.
2. Managing sponsor or victim private keys.
3. Constructing and submitting private bundles.
4. Auditing or deploying a rescue delegate contract.

## Bouquet Follow-Up

Bouquet should add a rescue mode that:

1. Imports Interceptor stacks containing type-4 transactions.
2. Signs or imports clear-delegation authorizations.
3. Inserts the sponsored clear-delegation transaction before funding and token sweep transactions.
4. Accounts for the victim authorization nonce increment before victim-signed follow-up transactions.
5. Submits the complete ordered bundle privately.

