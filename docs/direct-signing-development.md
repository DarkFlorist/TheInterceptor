# Direct signing development status

Direct Ledger and AirGap Vault signing is **not implemented end to end**. The modules in `app/ts/signing` are protocol and verification components; the provider and extension pages do not call them. Installing this branch does not enable device onboarding, hardware signing, or QR signing. Existing browser-wallet, simulation, website-permission, and Safe routes are unchanged.

## Implemented primitives

| Module | Scope |
| --- | --- |
| `ledgerFraming.ts` | Native byte arrays for Ledger's 64-byte HID framing, single-exchange response reassembly, strict channel/tag/sequence checks, response allocation limits, concrete BIP-32 path encoding. Native transport and APDU execution are implemented separately in `ledgerHid.ts` and `ledgerEthereum.ts`. |
| `airgapCbor.ts` | Definite-length CBOR integers, byte/text strings, arrays, unsigned integer-keyed maps, boolean values and tags. Rejects duplicate map keys, malformed UTF-8, indefinite lengths, unsupported simple values, excessive nesting, excessive node counts and trailing data. |
| `airgapBytewords.ts` | Minimal Bytewords encoding/decoding and big-endian CRC32, checked against the published Blockchain Commons vector. Accepts upper/lowercase minimal encoding. UR envelopes and fountain fragments are implemented in `airgapUr.ts`. |
| `ledgerHid.ts` / `ledgerEthereum.ts` | Native WebHID selection and sessions, extension-wide Web Lock, account/public-key verification, app-version checks, transaction/personal-sign/typed-data command execution, signature verification, cancellation, rejection and timeout handling. Not wired to extension pages. |
| `ledgerTypedData.ts` | Full EIP-712 structure/field streaming, including nested structs, arrays and chunked values; never uses hash-only signing. Ledger protocol limits are checked before device exchanges. |
| `airgapUr.ts` | Single and multipart UR, reference-compatible fountain selection and bounded decoding, tested against all twenty official bc-ur encoder vectors. |
| `airgapEthereum.ts` | Concrete Ethereum public-account imports, account-root public derivation, ERC-4527 requests for all three operations and independent UUID/signature verification. |
| `exactPayload.ts` | Immutable EIP-1559/personal-sign/EIP-712 payload values; independent account recovery; canonical signature checks; transaction reconstruction and comparison of every unsigned field. Reuses existing Ethereum serializers, hashes and recovery helpers. No signing or broadcasting. |
| `types/signingWallet.ts` / `background/storageVariables.ts` | Persistent public browser/Ledger/AirGap account bindings with one revision per address, public-key/address checks, atomic address creation/link/removal and stale-edit rejection. Shares the existing address-book write lock. Storage APIs are not yet connected to onboarding or provider routing. |

Settings backups use version 1.6 and include public wallet bindings. Restoring a backup assigns fresh revisions, invalidating any earlier approval tied to a wallet revision. Older backups explicitly clear bindings. Address-book deletion removes a binding when the last entry for that address disappears; a Safe entry in any chain scope excludes that address from ordinary signing. Multiple ordinary entries for the same address share one binding across chains. Restoring a contact does not resurrect an orphaned or Safe-address binding.

CBOR payloads are limited to 65,536 bytes, 4,096 nodes and 16 nesting levels. Minimal Bytewords input is bounded before normalization/allocation. Ledger response allocations are bounded by the caller's limit, at most 65,535 bytes. Invalid Ledger packets invalidate that decoder; its caller must establish a new exchange. The native transport invalidates cancelled/timed-out sessions and requires physical reconnection before reusing that device; a confirmed device rejection permits a new session.

The CBOR codec is deliberately a registry-oriented subset, not a general CBOR implementation. Tags are syntactically decoded without granting them meaning or trust. In particular, successful CBOR decoding must never be treated as accepting a public-account export: `airgapEthereum.ts` applies the separate registry validation that rejects private/master keys, unexpected curves, non-Ethereum paths, wildcard/child-range metadata and inappropriate account types. Account-root exports derive change 0 and a chosen index from 0 to 19; concrete five-component address exports are imported directly.

Payload creation is not transaction preparation from live chain state, user approval, or a persisted pending request. Its caller must supply real chain fields and bind approval to an immutable request identity. A valid signature establishes the signer and payload, not website permission, freshness, account ownership at import, or consent to broadcast. No mock signing utility is used in these modules.

UR decoding is limited to 512 fragments, 1,024 bytes per fragment, 4,096 input frames and 64 MiB of XOR work. Malformed or conflicting input closes the decoder and requires a fresh scan. EIP-712 JSON is bounded before recursive validation and rejects duplicate keys. A domain without a chain ID remains explicitly distinguishable from a chain-bound message.

## Sources inspected

- [Ledger Ethereum APDU specification](https://github.com/LedgerHQ/app-ethereum/blob/e5b6dbff3aca3e3c97a1079c8dccbd1dafdb32c7/doc/apdu.md) and [EIP-712 protocol](https://github.com/LedgerHQ/app-ethereum/blob/e5b6dbff3aca3e3c97a1079c8dccbd1dafdb32c7/doc/eip712.md). Full EIP-712 uses structure definitions, ordered values and the final signing command with P2=1; it is distinct from the legacy hash-only command. The documented minimum app version for the full protocol is 1.9.19, not a claim that every device/version combination works.
- [Ledger Python command-builder reference](https://github.com/LedgerHQ/app-ethereum/blob/e5b6dbff3aca3e3c97a1079c8dccbd1dafdb32c7/client/src/ledger_app_clients/ethereum/command_builder.py), used to check field descriptors, value chunking and the final full-EIP-712 signing command.
- [Ledger HID reference implementation](https://github.com/LedgerHQ/ledgerjs/blob/master/packages/devices/src/hid-framing.ts). Used to inspect the framing layout; no Ledger package is installed or imported.
- [ERC-4527](https://eips.ethereum.org/EIPS/eip-4527). Defines public-account metadata, Ethereum request and signature registries, including typed-transaction, typed-data and raw-byte request types. Its registry declarations alone do not establish interoperability with a particular Vault version.
- [Blockchain Commons Bytewords specification and vector](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-012-bytewords.md). Protocol alphabet reproduced with attribution under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The test vector exercises the binary codec only; it is not an accepted account import.
- [Blockchain Commons bc-ur reference](https://github.com/BlockchainCommons/bc-ur), including fountain selection and encoder vectors. The adapted algorithm and vector notices are retained in `app/licenses/bc-ur.txt`.
- Keystone `@keystonehq/bc-ur-registry-eth` 0.19.1 source (the version referenced by the inspected Vault package), inspected from its published archive without installing it into Interceptor; confirms ERC-4527 field numbers and request data types.
- [Blockchain Commons UR specification](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md). Multipart UR requires interoperable fountain handling, not concatenating independently numbered chunks.
- [AirGap Vault request matching](https://github.com/airgap-it/airgap-vault/blob/aa50b7f0371ed2e681f358d22b546c7c000e05b7/src/app/services/iac/iac.service.ts). Inspected its source-fingerprint/derivation-path wallet matching and transaction/message request handling. This inspection is not a Vault signing interoperability test.

## Remaining implementation

The original feature request remains open. Required work includes:

- Connect the persistent binding APIs to onboarding, linking/removal, availability display and address selector/Home changes. Browser onboarding must validate the selected provider's exposed account; Ledger onboarding must complete on-device address verification before saving. The storage codec validates public identity, not proof of signing authority.
- Independent remembered mode selections, browser callback isolation, unchanged website authorization, and routing of Safe owner signatures independently from execution accounts.
- Integrate the Ledger adapter with saved bindings, account discovery/on-device verification screens and the dedicated signing page. Validate actual device/app behavior and browser-wide session recovery.
- Animated QR generation, camera scanning, explicit Vault capability checks and real Vault interoperability checks. Integrate the existing registry/UR components with those UI flows.
- A dedicated signing page with exact final review, fee/nonce editing, expected-account guidance, device/offline states and explicit AirGap transaction broadcast confirmation.
- Live-chain transaction preparation, durable request identity/state, nonce coordination, stale-response rejection, worker-restart recovery, delayed-signature freshness checks and ambiguous-broadcast reconciliation.
- Integration with provider request/response semantics and comprehensive regression tests across browser wallets, simulation, website permissions and Safes.

No new runtime dependency or QR package has been added. Unit tests use existing cryptographic dependencies, local fixtures, the published EIP-712 Mail digest and official UR vectors. Deterministic native-shaped HID mocks exercise all three Ledger operations and session failure paths. These mocks are not a physical device or Ethereum-app emulator. No Ledger model, Ethereum app/firmware version, AirGap Vault device/version, camera/browser combination, emulator signing flow or live-chain broadcast has been verified. Physical-device verification must record those versions and separately exercise transaction, exact-byte personal-sign and full typed-data flows before advertising support.
