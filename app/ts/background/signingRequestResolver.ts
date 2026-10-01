import { getSigningMethodError } from '../signing/backend.js'
import { isSigningOperation } from '../types/signingMethods.js'
import { prepareSavedBrowserWalletForwarding } from './browserWalletForwarding.js'
import { browserSigningRequestAccount } from '../signing/browserWallet.js'
import { parseDirectSigningTypedData } from '../signing/exactPayload.js'
import { getSigningWalletBinding } from './storageVariables.js'
import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { JsonRpcResponseError } from '../utils/errors.js'

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
) {
	const binding = activeAddress === undefined ? undefined : await getSigningWalletBinding(activeSafeSigner ?? activeAddress)
	const directWallet = binding !== undefined && binding.wallet.type !== 'browser'
	if (!settings.simulationMode && directWallet && request.method === 'eth_signTypedData_v4' && 'params' in request && Array.isArray(request.params) && typeof request.params[1] === 'string') parseDirectSigningTypedData(request.params[1])
	const forwardToSigner = !settings.simulationMode && !directWallet && !request.usingInterceptorWithoutSigner
	const getForwardingMessage = async <T extends { readonly method: string }>(forwardedRequest: T) => {
		if (!forwardToSigner) throw new Error('Should not forward to signer')
		if (binding?.wallet.type !== 'browser') return { type: 'forwardToSigner' as const, ...forwardedRequest }
		const requireSelectedAccount = isSigningOperation(forwardedRequest.method)
		const fields = await prepareSavedBrowserWalletForwarding(websiteTabConnections, socket, binding, { requireSelectedAccount, requestedAddress: parsedRequest === undefined ? undefined : browserSigningRequestAccount(parsedRequest) })
		if (fields.error !== undefined) throw new JsonRpcResponseError({ jsonrpc: '2.0', id: request.uniqueRequestIdentifier.requestId, error: fields.error })
		return { type: 'forwardToSigner' as const, ...forwardedRequest, expectedProviderId: fields.expectedProviderId }
	}

	const capabilityError = binding === undefined ? undefined : getSigningMethodError(binding.wallet.type, request.method)
	const admissionError = !settings.simulationMode && capabilityError !== undefined ? { code: 4200, message: capabilityError }
		: !settings.simulationMode && parsedRequest !== undefined && isSigningOperation(parsedRequest.method) && binding === undefined && !safeSigningMode && (settings.selectedSigningAddress !== undefined || request.usingInterceptorWithoutSigner)
			? { code: 4100, message: 'No signing wallet for this address. Set up signing wallet or switch to simulation.' } : undefined
	return { forwardToSigner, getForwardingMessage, admissionError }
}
