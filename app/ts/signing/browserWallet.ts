import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { TabState } from '../types/user-interface-types.js'
import type { SigningWallet } from '../types/signingWallet.js'

type BrowserWallet = Extract<SigningWallet, { type: 'browser' }>
type BrowserSignerState = Pick<TabState, 'signerName' | 'signerProvider'>

/** RDNS is stable across page sessions; EIP-6963 UUIDs are not persistent wallet identities. */
export function browserWalletProviderId(state: BrowserSignerState) {
	if (state.signerProvider?.ambiguous) return undefined
	return state.signerProvider?.rdns === undefined ? `legacy:${ state.signerName }` : `eip6963:${ state.signerProvider.rdns }`
}

export function matchesBrowserSigningWallet(wallet: BrowserWallet, state: BrowserSignerState) {
	const providerId = browserWalletProviderId(state)
	if (providerId === undefined || wallet.signerName !== state.signerName) return false
	// Keep old name-only bindings readable; newly saved accounts use the discovered provider ID.
	return wallet.providerId === providerId || wallet.providerId === wallet.signerName
}

/** Shared admission for reviewed requests and browser-owned forwarding on networks without an RPC. */
export function prepareBrowserWalletForwarding(wallet: BrowserWallet, state: BrowserSignerState & Pick<TabState, 'signerConnected' | 'signerAccounts'>, options: { requireSelectedAccount?: boolean, requestedAddress?: bigint } = {}) {
	if (!matchesBrowserSigningWallet(wallet, state) || (options.requireSelectedAccount ?? true) && (!state.signerConnected || state.signerAccounts[0] !== wallet.address || options.requestedAddress !== undefined && options.requestedAddress !== wallet.address)) {
		return { error: { code: 4100, message: 'Select the expected account in the saved browser wallet before continuing. The wallet identity or account is different, disconnected, or ambiguous.' } }
	}
	return { expectedProviderId: wallet.providerId }
}


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
