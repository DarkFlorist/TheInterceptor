# RPC selection and entry matching

`app/ts/utils/rpcNetworkChange.ts` owns three different comparisons:

| Comparison | Meaning | Consumers |
| --- | --- | --- |
| Chain ID | The wallet must select a different chain. | Wallet-switch routing |
| Chain ID and RPC URL | The simulation endpoint changed. | Service replacement and accepted-endpoint verification |
| Serialized selection or entry snapshot | The selected configuration or a configured list entry changed. | Settings publication, dropdown selection, editing, removal, and primary promotion |

## Decision and scope

The selection key includes the full `RpcNetwork` serialization. The entry key uses that serialization with configured-entry `primary` and `minimized` preferences normalized away. Preference changes therefore do not detach the active selection from its list entry. These are transient value-comparison keys, not persisted IDs or a versioned wire format. Entry keys do not depend on list order.

URL-only matching cannot distinguish entries that share an endpoint across chains, or same-chain entries with different currency or explorer configuration. The current list model permits those entries. Keeping their complete configuration distinct prevents editing, removing, or promoting an unrelated entry. Exact duplicates are rejected by the editor. Metadata changes do not require a provider reset: that decision uses the separate endpoint comparison.

The tradeoff is intentional: renaming an entry or rotating its explorer API key changes its snapshot key. `saveRpcEntryAndKeepActiveRpcConsistent` receives the original entry so it can locate the old snapshot, check whether it is active, and replace it with the edited value. It rejects an original snapshot missing from the supplied list and preserves the current list preferences. Removal and promotion also match entry snapshots; a caller must not retain a key as a durable reference across edits.

Keys can contain credentials, including explorer API keys and credential-bearing RPC URLs. They are internal comparison values: do not log them, render them as labels, or use them as public identifiers. Hashing this serialization would conceal its literal contents but would not make its identity stable across edits.

## Schema evolution

`RpcNetwork.serialize` currently canonicalizes property order for comparisons within one schema. It is not a promise that keys remain byte-identical after a codec change. Adding fields, changing defaults, or reordering codec fields requires reviewing the shared helpers and their consumers. No persisted key migration is needed today, because keys are recomputed from values; persisted active selections and list entries still need compatible field/default migrations so equivalent configurations continue to match.

When changing the RPC schema, explicitly decide whether each field affects chain routing, endpoint replacement, entry matching, or only list preferences. Extend the existing classification, editor, promotion, and dropdown tests to cover that decision. In particular, retain coverage for same-URL entries, edits to an active entry, preference changes, stale editor snapshots, and credential-safe labels. Do not add an independent key derivation in a new consumer.

If a feature needs identity that survives renames, credential rotation, reordering, or import/export, introduce an explicit persisted entry ID with a migration for existing entries and active references. Define ID allocation, copying/import collisions, and deletion semantics together. That is a storage-model change, rather than another serialization or hashing convention, and is outside this popup-switching change.

## Display labels

`ChainSelector.getRpcEntryLabel` uses name, endpoint/chain differences, and currency metadata to distinguish options. When otherwise identical visible labels remain, it appends `connection N` according to the current list order instead of displaying secret-bearing metadata.

Those numbers are temporary presentation disambiguators. Removing or reordering entries can renumber them, and a lone remaining variant loses the suffix. Selection and mutation use the entry key, never the number or label. Features requiring a stable user-facing connection name should use explicit user-provided names or a persisted identity model, not rely on these ordinals.
