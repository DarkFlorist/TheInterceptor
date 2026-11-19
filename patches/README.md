# Dependency patches

`@noble/curves@2.2.0.patch` adds `ERR_SECP256K1_INVALID_POINT` to the two mathematical invalid-key outcomes used by Ethereum recovery: a non-residue in the secp256k1 square-root check and a recovered point at infinity. Point decoding preserves the original square-root error as `cause`. Both TypeScript source and distributed JavaScript carry the same change; curve arithmetic is unchanged.

`ethereumSigning.ts` delegates signing and recovery to `micro-eth-signer` and skips only these tagged recovery failures. Other exceptions propagate. The application does not import Noble internals or inspect dependency error messages.

Bun applies this patch through `patchedDependencies` in `package.json` and `bun.lock`. Docker copies the patch before its frozen install. When upgrading the dependency, explicitly rebase or remove the patch and run the recovery/nonce tests; do not replace the code check with error-message matching. The existing invalid-point and infinity tests fail if the installed library no longer supplies this contract, while the oversized-input case checks that untagged library failures propagate.
