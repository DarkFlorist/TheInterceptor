# Readable RPC parameter errors: wording funtypes failures from its internals

## Decision

Invalid parameters of a supported RPC method get a `-32602` reply that names the method, the parameter and the first problem. The wording comes from `app/ts/background/funtypesFailureExplanation.ts`, which walks funtypes codecs and failures through parts of funtypes that are not documented API:
- the codec `tag` names;
- the `underlying`, `fields`, `alternatives`, `components`, `intersectees`, `element` and `value` members;
- the grammar of `Failure.key`.

This coupling is deliberate and owned by this repository. That module is the only place that reads funtypes internals.

## Why

- funtypes has no public way to walk a failure down to the value that caused it. Its own messages describe the whole request union, which is what dapps received before (`Failed to parse RPC request: <request JSON>`).
- Hand-written messages per method would duplicate every request codec in prose, and would drift from the codecs that actually decide validity.
- The adapter never decides validity: it only words a rejection funtypes already made. The worst it can do is word that rejection badly, never accept or refuse a request.
- An upstream failure-walk API in funtypes would remove the coupling. If funtypes ever gains one, the adapter should move onto it.

## What protects an upgrade

- **Graceful degradation at runtime.** Before wording anything, the reply calls `isCodecLayoutRecognized`. For a tag or member layout it doesn't recognise, the reply falls back to the generic `Invalid <method> parameters` message built from funtypes' own failure text. A changed `Failure.key` grammar only stops the explanation early, at an enclosing value. So a funtypes upgrade can lose detail in these messages, but never makes them wrong and never changes which requests are accepted.
- **A switch.** `FUNTYPES_ADAPTER_ENABLED` turns the adapter off entirely (see the security upgrade below).
- **A gate in the tests.** `FUNTYPES_ADAPTER_VERSION` names the funtypes version the internals were validated against. `test/tests/funtypesFailureExplanation.test.ts` fails when `package.json` pins any other version. Its pinning tests check:
  - every codec tag funtypes and the real RPC codecs use;
  - the members the adapter reads;
  - the failure keys funtypes produces.

## How to upgrade funtypes

1. Bump the funtypes pin in `package.json` and run `bun run test`.
2. If only the version gate fails, the pinning tests confirm the internals still match. Set `FUNTYPES_ADAPTER_VERSION` to the new version.
3. If pinning tests fail, update `CODEC_TAGS_BY_HANDLING`, `isCodecLayoutRecognized` or the key parsing to the new layout until they pass, then set `FUNTYPES_ADAPTER_VERSION`.

**Security upgrades.** When a security fix has to ship before the adapter is re-validated, don't mark the new version as validated. Instead:
1. Bump the funtypes pin.
2. Set `FUNTYPES_ADAPTER_ENABLED` to `false` in `funtypesFailureExplanation.ts`, and leave `FUNTYPES_ADAPTER_VERSION` naming the last version that was actually validated.
   - Invalid-params replies then carry funtypes' own failure text (`Invalid <method> parameters…`) and walk no failure through funtypes internals. `rpcParseFailureReply.test.ts` checks this mode.
   - The tests of the adapter and of its detailed wording, including the version gate, are skipped, so `bun run test` stays green.
3. Re-validate the adapter in a follow-up, set `FUNTYPES_ADAPTER_VERSION` to the new version, and turn the adapter back on.
