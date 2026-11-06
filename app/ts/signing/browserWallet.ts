import { getBrowserProviderId } from '../utils/browserProviderIdentity.js'
import { EthereumAddress } from '../types/wire-types.js'
import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { TabState } from '../types/user-interface-types.js'
import type { SigningWallet } from '../types/signingWallet.js'

type BrowserWallet = Extract<SigningWallet, { type: 'browser' }>
type BrowserSignerState = Pick<TabState, 'signerName' | 'signerProvider'>

/** RDNS is stable across page sessions; EIP-6963 UUIDs are not persistent wallet identities. */
export function browserWalletProviderId(state: BrowserSignerState) {
	return getBrowserProviderId(state.signerName, state.signerProvider)
}

export function matchesBrowserSigningWallet(wallet: BrowserWallet, state: BrowserSignerState) {
	const providerId = browserWalletProviderId(state)
	if (providerId === undefined || wallet.signerName !== state.signerName) return false
	// Bare display-name bindings must be explicitly relinked; they never authorize a provider.
	return wallet.providerId === providerId
}

/** Shared admission for reviewed requests and browser-owned forwarding on networks without an RPC. */
export function prepareBrowserWalletForwarding(wallet: BrowserWallet, state: BrowserSignerState & Pick<TabState, 'signerConnected' | 'signerAccounts'>, options: { requireSelectedAccount?: boolean, requestedAddress?: bigint } = {}) {
	if (!matchesBrowserSigningWallet(wallet, state) || (options.requireSelectedAccount ?? true) && (!state.signerConnected || state.signerAccounts[0] !== wallet.address || options.requestedAddress !== undefined && options.requestedAddress !== wallet.address)) {
		return { error: { code: 4100, message: 'Select the expected account in the saved browser wallet before continuing. The wallet identity or account is different, disconnected, or ambiguous.' } }
	}
	return { expectedProviderId: wallet.providerId }
}


/** Wire-shape extraction, not a capability list: support/admission lives in backend.ts. */
export function browserSigningRequestAccount(request: EthereumJsonRpcRequest): bigint | undefined {
	switch (request.method) {
		case 'eth_sendTransaction': return request.params[0].from
		case 'personal_sign':
		case 'eth_signTypedData': return request.params[1]
		case 'eth_sign':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return request.params[0]
		default: return undefined
	}
}

export type UnparsedSigningRequestAccount = { readonly readable: true, readonly address: bigint | undefined } | { readonly readable: false }

/** The account of a signing request Interceptor has no schema for. EIP-5792 wallet_sendCalls names it in an optional `from`, and without one the wallet signs with its selected account. Other unparsed signing methods have no account Interceptor can read. */
export function unparsedSigningRequestAccount(request: { readonly method: string, readonly params?: unknown }): UnparsedSigningRequestAccount {
	if (request.method !== 'wallet_sendCalls' || !Array.isArray(request.params)) return { readable: false }
	const [calls] = request.params
	if (typeof calls !== 'object' || calls === null) return { readable: false }
	if (!('from' in calls) || calls.from === undefined) return { readable: true, address: undefined }
	const from = EthereumAddress.safeParse(calls.from)
	return from.success ? { readable: true, address: from.value } : { readable: false }
}
