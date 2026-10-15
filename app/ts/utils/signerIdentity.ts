export const internalSignerStatuses: ReadonlySet<string> = new Set(['NoSigner', 'NotRecognizedSigner', 'NoSignerDetected', 'EIP6963'])

// Provider display names are untrusted metadata; signer state uses this closed identity instead.
export type SignerIdentity = 'NoSigner' | 'NotRecognizedSigner' | 'NoSignerDetected' | 'MetaMask' | 'Ambire' | 'Brave' | 'CoinbaseWallet' | 'Rabby' | 'EIP6963'
