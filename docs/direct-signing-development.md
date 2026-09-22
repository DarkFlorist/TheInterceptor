# Direct signing

Interceptor includes local Ledger WebHID and AirGap ERC-4527 signing adapters, address-based wallet bindings, dedicated setup/signing pages, and a persisted signing pipeline. These paths use the existing Ethereum serializers and cryptographic dependencies. Nano X emulator and Vault reference-library interoperability are verified below; physical devices remain unverified.

## Setup and use

Open **Change** beside the active address, then **Add address / signing wallet**. The setup page offers browser wallet, Ledger, AirGap Vault, and manual address options. Adding or changing a wallet does not switch modes or authorize a website.

- **Browser wallet:** open an approved website, click **Connect browser wallet** in setup, and select an exposed account after approving the connection in the wallet. Interceptor continues to use its existing browser-provider bridge and browser-wallet-owned transaction submission. New bindings retain the announced EIP-6963 reverse-DNS provider identity and account. UUIDs identify providers only within a page session. Conflicting identities are rejected, including immediately before forwarding a signing request. EIP-6963 metadata is self-reported, not authenticated. Legacy providers and existing name-only bindings retain their prior name-based behavior; relink after discovery to save the stronger identity.
- **Ledger:** use desktop Chrome/Chromium with WebHID and Web Locks, unlock the device, and open Ethereum. Discover the first five Ledger Live accounts, or enter a concrete derivation path. Select an account and verify its address on the device before saving. Ledger Live account N uses `m/44'/60'/N'/0/0`; legacy address index N uses `m/44'/60'/0'/0/N`. Reconnection verifies the saved public key and address before signing. The adapter checks for Ethereum app 1.9.19 or newer and streams full EIP-712 definitions and values; it has no hash-only fallback.
- **AirGap Vault:** export an Ethereum `crypto-account` or `crypto-hdkey` public-account UR and scan it with the camera. The scanner recognizes either format automatically and locks that format for the scan. Review and name the imported accounts. Account-root exports derive change 0, index 0; concrete address exports retain their supplied path. An imported account is awaiting offline signing, not continuously connected. Public-account import does not establish possession of a private key; every returned signature is independently verified.
- **Manual:** enter an address and name. It remains available for chain reads and simulation. Real signing requires a wallet binding.

Saved accounts remain visible while disconnected. Selecting an ordinary address in Signing mode pins it independently of browser-wallet account and chain callbacks. **Change signing wallet** edits the same address without selecting it; removing a binding retains the address. **Simulate this address** changes the simulation selection without changing the remembered explicit signing selection. The Simulating and Signing buttons switch modes; each mode remembers its address selection. Legacy browser-wallet-following selections remain supported.

For a Safe, select a saved signing-owner account under **Safe signing accounts**. Interceptor checks current on-chain ownership. The owner’s binding supplies owner signatures; a separate execution/gas-paying account can be selected. Simulation-owner selection remains separate. An owner signature does not itself broadcast an outer execution transaction.

## Review, sign, and submit

The existing confirmation window retains the transaction explanation and simulation warnings. For a direct wallet, continuing opens a dedicated extension tab. That tab displays the originating website, real-signing mode, account, chain, wallet, exact payload, and final transaction fee ceiling. Transaction preparation reads nonce, gas, and fees from the configured RPC without applying the hypothetical simulation stack.

Review the exact payload, then approve with Ledger or AirGap. The Ledger path verifies the account again, waits for device approval, and independently verifies the signature. Cancellation, timeout, or malformed responses invalidate the device session; disconnect/reconnect the device before retrying. Device rejection permits a clean retry.

The AirGap page animates bounded multipart UR frames with pause, next-frame, and speed controls. Scan them in Vault, review and sign offline, then enable Interceptor’s camera to scan the signature response. A denied camera permission or malformed scan is shown explicitly. Restart the scan after malformed UR input. The scanner releases camera tracks when stopped or unmounted.

Both direct adapters support EIP-1559 `eth_sendTransaction`, exact hex-byte `personal_sign`, and `eth_signTypedData_v4`. Other direct-signing operations and transaction types are rejected. Device support for a particular payload can be narrower than the transport specification; unsupported app commands are reported instead of falling back to hash signing.

A verified transaction is **signed**, not yet submitted. **Broadcast transaction** explicitly authorizes submission through the captured RPC. Fees and advanced nonce can be edited before approval, or after a signature by invalidating that signature. Editing requires another review and signature. Final transaction preparation and fee edits refresh the existing simulated explanation, and approval waits for the matching payload revision. Review the refreshed explanation in the confirmation window alongside the exact fields in the signing tab. Nonces must match the RPC’s current pending nonce; this UI does not create intentional replacement transactions or queue future nonces.

Before initial broadcast, Interceptor rechecks chain, nonce, balance, and fee conditions. The signed transaction is reconstructed and every unsigned field compared with the approved payload. The transaction hash and submitting state are persisted before the RPC call. If submission is ambiguous, **Reconcile transaction by hash** queries the same hash and may resend only the identical signed bytes. Submitted and confirmed states are distinct, including reverted receipts. No fresh signature or replacement payload is produced automatically.

Changing the saved wallet invalidates an outstanding request; cancel it and request a fresh review from the application. Selecting another address elsewhere does not reroute it. Approval and signature state survive background-worker reloads and can be resumed by reopening the signing tab from its original confirmation. Closing/rejecting the original confirmation invalidates unsubmitted work. Imported settings clear the explicit ordinary signing selection.

Settings backups use version 1.7 to include wallet bindings and Safe Apps compatibility together. Existing version 1.6 backups retain their Safe Apps setting when imported and clear local wallet bindings, since that format did not store them.

## Bounds and dependencies

The CBOR codec is a registry-oriented subset: definite-length integers, byte/text strings, arrays, unsigned integer-keyed maps, booleans, and tags. It rejects duplicate keys, malformed UTF-8, indefinite lengths, excessive nesting/work, and trailing data. Account import separately rejects private/master keys, inappropriate curves or key paths, wildcards, and child ranges.

Limits: CBOR 65,536 bytes, 4,096 nodes and 16 levels; UR 512 fragments, 1,024 bytes per fragment, 4,096 received frames, and 64 MiB XOR work; typed JSON 65,536 bytes with duplicate-key and complexity checks; HID response allocation at most 65,535 bytes. Camera frames are scaled to 640 × 480 and decoded sequentially. Signing request storage is capped at 16 records and 4 MiB, with bounded recent terminal history. Device access is serialized with an extension-wide Web Lock, and background request mutations and nonce reservations are serialized.

The only added runtime dependency is **`qr@0.7.0`**, for QR pixel generation and decoding. Its published manifest has no runtime dependencies. Its encoder and decoder are local ES modules; Interceptor uses native `getUserMedia` and controls frame size, scan scheduling, UR input limits, and camera lifetime itself. License: [qr.txt](../app/licenses/qr.txt). No Ledger SDK, transport package, AirGap SDK, or wallet framework is used.

## Verification record and limitations

Automated tests cover native-shaped HID exchanges for all three operations, framing, EIP-712 streaming, cancellation/rejection/disconnection, public-account parsing, official UR reference vectors, large/reordered/malformed inputs, actual QR pixel round trips, exact-signature and signed-field verification, persisted approval/signature phases, changed wallets, stale responses, nonce coordination, delayed nonce changes, ambiguous submission, and provider access without another wallet. Existing browser-wallet and Safe test suites remain part of required validation.

Chrome for Testing 145.0.7632.6 on Linux passed the real extension communication, browser-wallet signing, and Safe co-signing/stack-handoff smoke checks using local fixture pages, simulated browser providers, and a local RPC fixture for the Safe checks. The communication check also covers an authorized saved address without another wallet installed and missing-binding signing rejection.

Ledger Ethereum **1.22.3**, the latest stable release checked on 2026-09-22, ran as the official **Nano X** ELF in **Speculos 0.27.0**. All three signing methods produced signatures independently verified by Interceptor, with Raw messages both disabled and enabled. Captured device text and public-test-account signatures are in `test/fixtures/directSigning/ledger-nanox-1.22.3*.json`. This exercises the real Ethereum app over emulator APDUs; WebHID framing remains covered by native-shaped transport tests.

AirGap Vault **3.34.4**, the latest stable release checked on 2026-09-22, was inspected at `aa50b7f0371ed2e681f358d22b546c7c000e05b7`. Its pinned Ethereum and UR reference libraries import an account-root export, decode Interceptor requests, sign all three operations, encode replies, and pass Interceptor’s independent verification. Cases include binary personal-message bytes, typed arrays/large integers, and multipart fountain decoding in both directions after dropping systematic fragments. The harness follows Vault’s `@airgap/angular-core@0.0.62` conversion/generator paths, including its v0 adapter’s delegation to the v1 Ethereum protocol, serializer, and key derivation; it does not run the Angular UI or an installed Vault app. Checked-in vectors reproduce the cryptographic/QR checks without reference packages.

No physical Nano X/firmware, physical AirGap device, real camera/browser combination, or live-chain broadcast has been verified in this workspace. Test each of transaction, exact-byte personal signing, and full typed data on the target device/version before relying on it. Firefox has no native WebHID path; camera/QR support must be checked separately.

Browser onboarding currently selects accounts already exposed to an approved application; it does not install or discover additional wallet extensions. Legacy same-name browser providers remain indistinguishable. ERC-4527 account exports contain no installed-app version or capability advertisement, so automatic Vault version detection is unavailable. The UI states the tested version and supported operations instead of inferring signing capability from public import. Browser-owned transaction broadcasting retains its existing response semantics.

## Nano X screen comparison

The signing tab shows **Compare with your Ledger Nano X**, a local screen-by-screen preview based on Ethereum 1.22.3. It uses the device’s labels and formatting for ordinary Ethereum transfers, personal messages, and EIP-712 review. Previous/Next changes only the preview. It does not approve a request or send a device command.

Match the optional **Nonce**, **Transaction / message hash**, and **Raw messages** controls to the device’s Ethereum App settings. Those settings are not exposed by the configuration APDU. With Raw messages off, typed-data review shows domain fields and a message-struct hash; with it on, the full protocol allows field review. This adapter sends full EIP-712 data in both cases. Ethereum 1.22.3 requires Blind signing for this unfiltered typed-data path; the preview shows its warning. Pressing both buttons at the device’s skip prompt skips raw fields.

This is a content comparison, not a pixel-perfect emulator: fonts, wrapping, pagination, long-value truncation, plugins, and dynamically loaded network metadata can differ. Interceptor keeps full values and the exact payload visible; never treat its simulated explanation or preview as evidence of what a physical device displayed.

## Reproduce the reference checks

These optional tools are development-only and add no extension or repository dependencies. Use isolated directories; only the published test seed is used, and no RPC submission occurs.

For Ledger, install `speculos==0.27.0` in a Python virtual environment with its documented system prerequisites. Download the Nano X ELF from the official Ethereum 1.22.3 release, source commit `d6d699bcdaf5dc4d99722f38cbbbfb466c0f3163`. The tested ELF SHA-256 is `47705998a0419df75959f46faf2c4a214846f61943fd15d3708b92caf2a3559f`. Start a fresh emulator with its default public test seed:

```sh
speculos /path/to/ethereum-nanox.elf --model nanox --display headless --api-port 5010 --apdu-port 10001
bun test/benchmarks/ledgerNanoXReference.ts
bun test/benchmarks/ledgerNanoXReference.ts --raw-messages
```

The harness uses only localhost port 5010, configures emulator settings, advances review screens, and records verified results. Never connect this automated approval harness to physical hardware or real accounts.

For AirGap, create a separate temporary npm project and install these exact reference versions there with scripts disabled:

```sh
npm install --ignore-scripts --save-exact @airgap/ethereum@0.13.46 @airgap/coinlib-core@0.13.46 @airgap/crypto@0.13.46 @airgap/module-kit@0.13.46 @airgap/serializer@0.13.46 @keystonehq/bc-ur-registry-eth@0.19.1 @ngraveio/bc-ur@1.1.6 @ethereumjs/tx@3.4.0
```

From this repository, run `AIRGAP_REFERENCE_DIR=/path/to/isolated/project bun test/benchmarks/airgapVaultReference.ts`. These external reference libraries are not imported by extension code or the normal test suite. `bun test test/tests/directSigningReference.test.ts` verifies the committed outputs using existing project dependencies only.

## Protocol sources

- [Ledger Ethereum APDUs](https://github.com/LedgerHQ/app-ethereum/blob/d6d699bcdaf5dc4d99722f38cbbbfb466c0f3163/doc/apdu.md) and [full EIP-712 protocol](https://github.com/LedgerHQ/app-ethereum/blob/d6d699bcdaf5dc4d99722f38cbbbfb466c0f3163/doc/eip712.md).
- [Ledger reference EIP-712 command builder](https://github.com/LedgerHQ/app-ethereum/blob/d6d699bcdaf5dc4d99722f38cbbbfb466c0f3163/client/src/ledger_app_clients/ethereum/command_builder.py) and [HID framing](https://github.com/LedgerHQ/ledgerjs/blob/master/packages/devices/src/hid-framing.ts).
- [ERC-4527](https://eips.ethereum.org/EIPS/eip-4527), [Bytewords](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-012-bytewords.md), [UR](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md), and [bc-ur reference implementation](https://github.com/BlockchainCommons/bc-ur). Adaptation/vector notices: [bc-ur.txt](../app/licenses/bc-ur.txt).
- [AirGap Vault account/request matching](https://github.com/airgap-it/airgap-vault/blob/aa50b7f0371ed2e681f358d22b546c7c000e05b7/src/app/services/iac/iac.service.ts).
- [QR package source and manifest](https://github.com/paulmillr/qr).

See the [UI walkthrough](direct-signing-ui-walkthrough.md) for captioned screenshots of address selection, onboarding, review, offline signing, camera recovery, and broadcast confirmation using fixture data.
