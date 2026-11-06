type SignerIdentityDefinition = {
	readonly kind: 'wallet' | 'status' | 'selected-provider'
	readonly displayName: string
	readonly missing: boolean
}

const defineSignerIdentities = <const T extends Readonly<Record<string, SignerIdentityDefinition>>>(identities: T) => identities

// EIP6963 is an internal selected-provider marker; the actual wallet identity lives in the selected provider's validated metadata.
export const signerIdentities = defineSignerIdentities({
	NoSigner: { kind: 'status', displayName: 'Unknown signer', missing: true },
	NotRecognizedSigner: { kind: 'status', displayName: 'Unknown signer', missing: false },
	NoSignerDetected: { kind: 'status', displayName: 'Unknown signer', missing: true },
	MetaMask: { kind: 'wallet', displayName: 'MetaMask', missing: false },
	Ambire: { kind: 'wallet', displayName: 'Ambire Wallet', missing: false },
	Brave: { kind: 'wallet', displayName: 'Brave', missing: false },
	CoinbaseWallet: { kind: 'wallet', displayName: 'CoinbaseWallet', missing: false },
	Rabby: { kind: 'wallet', displayName: 'Rabby Wallet', missing: false },
	EIP6963: { kind: 'selected-provider', displayName: 'Selected wallet', missing: false },
})

export type SignerName = keyof typeof signerIdentities
export type WalletSignerName = { [Name in SignerName]: typeof signerIdentities[Name]['kind'] extends 'wallet' ? Name : never }[SignerName]

const signerNames: ReadonlySet<string> = new Set(Object.keys(signerIdentities))
export const internalSignerStatuses: ReadonlySet<string> = new Set(Object.entries(signerIdentities).filter(([, identity]) => identity.kind !== 'wallet').map(([name]) => name))
export const isSignerName = (value: unknown): value is SignerName => typeof value === 'string' && signerNames.has(value)
export const isWalletSignerName = (name: SignerName): name is WalletSignerName => signerIdentities[name].kind === 'wallet'
