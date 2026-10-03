import { getSafeModeRpcPolicyReply } from '../safe/safeRequestPolicy.js'
import type { ConfirmationRequest } from '../types/confirmationRequest.js'
import { getSigningMethodError } from '../signing/backend.js'
import { isSigningOperation } from '../types/signingMethods.js'
import { prepareSavedBrowserWalletForwarding } from './browserWalletForwarding.js'
import { browserSigningRequestAccount } from '../signing/browserWallet.js'
import { parseDirectSigningTypedData } from '../signing/exactPayload.js'
import { getSigningWalletBinding } from './storageVariables.js'
import { SupportedEthereumJsonRpcRequestMethods, type EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { isAccountOnlyMethod } from './accountRequestMethods.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'

/** Admission owns wallet routing and early errors. Persisted signing revalidates at the approval boundary. */
export async function resolveSigningRequest(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	parsedRequest: EthereumJsonRpcRequest | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
	activeSafeSigner: bigint | undefined,
	safeSigningMode: boolean,
	simulationOverlayEnabled: boolean,
	confirmation: ConfirmationRequest | undefined,
) {
	const walletForwardingRequested = parsedRequest === undefined
		? !SupportedEthereumJsonRpcRequestMethods.test(request)
		: settings.activeRpcNetwork.httpsRpc === undefined && !isAccountOnlyMethod(parsedRequest.method)
			|| parsedRequest.method === 'wallet_addEthereumChain'
			|| parsedRequest.method === 'eth_getStorageAt' && !simulationOverlayEnabled
			|| parsedRequest.method === 'wallet_getCapabilities' && parsedRequest.params[0] === activeAddress && !safeSigningMode && activeSafeSigner === undefined
	const needsBinding = !settings.simulationMode && (isSigningOperation(request.method) || walletForwardingRequested)
	const binding = !needsBinding || activeAddress === undefined ? undefined : await getSigningWalletBinding(activeSafeSigner ?? activeAddress)
	const directWallet = binding !== undefined && binding.wallet.type !== 'browser'
	if (directWallet && request.method === 'eth_signTypedData_v4' && 'params' in request && Array.isArray(request.params) && typeof request.params[1] === 'string') parseDirectSigningTypedData(request.params[1])
	const forwardToSigner = !settings.simulationMode && !directWallet && !request.usingInterceptorWithoutSigner
	const safePolicyReply = getSafeModeRpcPolicyReply({ rawRequest: request, confirmation, parsedRequest, safeSigningMode, forwardToSigner, activeAddress, chainId: settings.activeRpcNetwork.chainId, hasRpcConnection: settings.activeRpcNetwork.httpsRpc !== undefined })
	let forwarding: { type: 'forwardToSigner', expectedProviderId?: string } = { type: 'forwardToSigner' }
	let forwardingError: ErrorWithCodeAndOptionalData | undefined
	if (safePolicyReply === undefined && forwardToSigner && walletForwardingRequested && binding?.wallet.type === 'browser') {
		const fields = await prepareSavedBrowserWalletForwarding(websiteTabConnections, socket, binding, { requireSelectedAccount: isSigningOperation(request.method), requestedAddress: parsedRequest === undefined ? undefined : browserSigningRequestAccount(parsedRequest) })
		if (fields.error !== undefined) forwardingError = fields.error
		else forwarding = { type: 'forwardToSigner', expectedProviderId: fields.expectedProviderId }
	}

	const capabilityError = binding === undefined ? undefined : getSigningMethodError(binding.wallet.type, request.method)
	const admissionError = !settings.simulationMode && capabilityError !== undefined ? { code: 4200, message: capabilityError }
		: !settings.simulationMode && parsedRequest !== undefined && isSigningOperation(parsedRequest.method) && binding === undefined && !safeSigningMode && (settings.selectedSigningAddress !== undefined || request.usingInterceptorWithoutSigner)
			? { code: 4100, message: 'No signing wallet for this address. Set up signing wallet or switch to simulation.' } : forwardingError
	// Return the actual forwarding reply so the router cannot independently choose an unpinned forwarding path.
	const forwardingRequest = settings.activeRpcNetwork.httpsRpc !== undefined && (parsedRequest?.method === 'wallet_addEthereumChain' || parsedRequest?.method === 'eth_getStorageAt') ? parsedRequest : request
	const forwardingReply = safePolicyReply === undefined && admissionError === undefined && forwardToSigner && walletForwardingRequested
		? parsedRequest?.method === 'wallet_addEthereumChain' && settings.activeRpcNetwork.httpsRpc !== undefined
			? { ...parsedRequest, ...forwarding }
			: { ...forwardingRequest, ...forwarding, replyWithSignersReply: true as const }
		: undefined
	return { forwardingReply, admissionError, safePolicyReply }
}
