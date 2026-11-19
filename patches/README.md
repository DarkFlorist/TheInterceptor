# Dependency patches

`micro-eth-signer@0.19.0` resolves its own transitive `@noble/curves@2.2.0`. That is the copy patched here; the separate root dependency `@noble/curves@1.9.1` is not used by application recovery.

`@noble/curves@2.2.0.patch` adds the locally defined `ERR_SECP256K1_INVALID_POINT` code at the existing secp256k1 non-residue and recovered-infinity errors. Point decoding preserves the square-root error as `cause`. TypeScript and distributed JavaScript agree; arithmetic is unchanged. This code is our patch contract, not an upstream Noble API.

`ethereumSigning.ts` delegates recovery to `micro-eth-signer` and inspects that code directly or on the preserved cause. Untagged errors propagate. It does not inspect human-readable diagnostics or import curve internals.

`check:recovery-dependency` resolves micro from the application's signing directory, then resolves Noble relative to that micro copy. It checks the installed micro pin, requires a patch for the actual transitive Noble version, and probes both invalid-point outcomes through the application API. Tests, typecheck and extension compilation run this guard before proceeding. Hoisting is accepted when the resolved versions and contract still match; a mismatched version or missing tag fails before a bundle is produced.

Bun applies the patch through `patchedDependencies` in `package.json` and `bun.lock`; Docker copies it before the frozen install. When upgrading micro or Noble, explicitly rebase/remove the patch and run the guard and recovery/nonce tests. The invalid-point tests enforce the tags; an oversized-input test enforces propagation of untagged library failures.
