import type { RpcNetwork } from '../types/rpc.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { SigningWalletBindings } from '../types/signingWallet.js'
import { resolveSafeSigningPlan } from './safeSigningPlan.js'

export type RequestRoutingState = {
	readonly simulationMode: boolean
	readonly signerAvailable: boolean
}

// Whether the active address signs with a Ledger or AirGap wallet: a Safe signs through the signing owner of the shared signing plan (its saved owner, else the wallet's selected account), as request routing does; any other address through its own binding.
export function isActiveAddressSigningDirectly(activeAddress: AddressBookEntry | undefined, bindings: SigningWalletBindings, walletSelectedAccount: bigint | undefined) {
	const signingAccount = activeAddress?.type === 'safe' ? resolveSafeSigningPlan(activeAddress, walletSelectedAccount).signingOwner : activeAddress?.address
	const wallet = bindings.find((binding) => binding.wallet.address === signingAccount)?.wallet
	return wallet !== undefined && wallet.type !== 'browser'
}

// signerAvailable: a browser wallet is connected and signs for the active address. An address saved with a Ledger or AirGap wallet signs inside the Interceptor, so no browser wallet receives its requests.
export function getRequestRoutingState(simulationMode: boolean, browserSignerAvailable: boolean, activeAddressSignsDirectly: boolean): RequestRoutingState {
	return { simulationMode, signerAvailable: browserSignerAvailable && !activeAddressSignsDirectly }
}

// Signing mode with an available signer lets the signer answer requests the Interceptor does not handle itself.
export function isForwardingRequestsToSigner({ simulationMode, signerAvailable }: RequestRoutingState) {
	return !simulationMode && signerAvailable
}

// Without an Interceptor RPC, signing mode passes requests straight to the signer; simulation mode (or a missing signer) still intercepts them. The one implementation of this rule: request forwarding and the network-without-RPC warnings both use it.
export function isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, routingState: RequestRoutingState) {
	return rpcNetwork.httpsRpc === undefined && isForwardingRequestsToSigner(routingState)
}
