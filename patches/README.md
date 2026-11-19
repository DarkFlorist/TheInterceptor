# Dependency patches

`@noble/curves@2.2.0` is a direct build dependency because `build/vendor.mts` copies its root package into the extension. The same version satisfies `micro-eth-signer@0.19.0`; it is the sole installed curve-library version. Application and test code do not import Noble curve APIs directly.

`@noble/curves@2.2.0.patch` adds the locally defined `ERR_SECP256K1_INVALID_POINT` code at the existing secp256k1 non-residue and recovered-infinity errors. Point decoding preserves the square-root error as `cause`. TypeScript and distributed JavaScript agree; arithmetic is unchanged. This code is our patch contract, not an upstream Noble API.

`ethereumRecoveryBackend.ts` is the sole adapter for dependency-specific recovery behavior. It delegates to `micro-eth-signer`, translates the local code/cause metadata into a typed success/failure result, and propagates untagged exceptions. `ethereumSigning.ts` consumes that result without knowing the dependency tag or nesting. No human-readable diagnostics control recovery.

`check:recovery-dependency` resolves micro from the actual adapter module, then resolves Noble relative to that micro copy. It checks the micro and direct Noble pins, requires recovery and the root package copied by vendoring to resolve to the same real directory, verifies the patch declaration, and probes both invalid-point outcomes through that same adapter. Tests, typecheck and extension compilation run this guard before proceeding. The vendor implementation itself runs it before deleting or copying output, including when invoked directly. Hoisting is accepted when recovery and vendoring share the same package tree; a version, source-copy or tag mismatch fails before output is copied or a bundle is produced.

Bun applies the patch through `patchedDependencies` in `package.json` and `bun.lock`; Docker copies it before the frozen install. When upgrading micro or Noble, explicitly rebase/remove the patch and run the guard and recovery/nonce tests. The invalid-point tests enforce the tags; an oversized-input test enforces propagation of untagged library failures.
