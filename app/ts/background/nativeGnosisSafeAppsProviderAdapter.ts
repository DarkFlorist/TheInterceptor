import { runSignerStateOperation } from './signerStateOwnership.js'
import { connectedToSigner as handleConnectedToSigner, signerReply as handleSignerReply, applySignerReply, getConnectedToSignerResult } from './providerMessageHandlers.js'
import { getNativeGnosisSafeAppsAuthority, notifyNativeGnosisSafeAppsSessionConnections } from './nativeGnosisSafeAppsSessions.js'
import { takeNativeGnosisSafeAppsSignerReply } from './nativeGnosisSafeAppsSigner.js'
import { NATIVE_GNOSIS_SAFE_APPS_SIGNER_REPLY } from '../../shared/ts/nativeGnosisSafeAppsSignerProtocol.js'
import { SignerReply } from '../types/interceptor-messages.js'
import { getSocketFromPort, isTopFramePort } from './backgroundUtils.js'
import { routeProviderReply } from './providerReplyRouting.js'

// Resolve feature authority at dispatch. The core handler still owns synchronous generation announcements and checks supersession before and after asynchronous confirmation work.
export const connectedToSigner = async (...args: Parameters<typeof handleConnectedToSigner>) => {
	const [, connections, port] = args
	const authority = getNativeGnosisSafeAppsAuthority(connections, port)
	if (authority.kind === 'staleSigner') return await getConnectedToSignerResult()
	const nativeSigner = authority.kind === 'signer'
	return await handleConnectedToSigner(args[0], connections, port, args[3], args[4], args[5], {
		isTopFrame: isTopFramePort(port) || nativeSigner,
		isCurrent: () => getNativeGnosisSafeAppsAuthority(connections, port).kind === (nativeSigner ? 'signer' : authority.kind),
		confirmed: () => { if (nativeSigner) notifyNativeGnosisSafeAppsSessionConnections(connections) },
	})
}

export const signerReply = async (...args: Parameters<typeof handleSignerReply>) => {
	const [, connections, port, request] = args
	const params = SignerReply.parse(request).params[0]
	if (params.forwardRequest.method !== NATIVE_GNOSIS_SAFE_APPS_SIGNER_REPLY) {
		if (getNativeGnosisSafeAppsAuthority(connections, port).kind === 'staleSigner') return { type: 'doNotReply' as const }
		return await handleSignerReply(...args)
	}
	const socket = getSocketFromPort(port)
	if (socket === undefined) return { type: 'doNotReply' as const }
	return await runSignerStateOperation(connections, socket.tabId, async () => {
		const native = await takeNativeGnosisSafeAppsSignerReply(connections, port, params)
		if (native === undefined) return { type: 'doNotReply' as const }
		const result = await applySignerReply(args[0], connections, port, { ...request, uniqueRequestIdentifier: { ...request.uniqueRequestIdentifier, requestSocket: socket } }, {
			uniqueRequestIdentifier: native.uniqueRequestIdentifier,
			params: { ...native.reply, forwardRequest: { ...native.forward, requestId: native.uniqueRequestIdentifier.requestId } },
	})
	if (result.type === 'result') routeProviderReply(connections, { ...result, uniqueRequestIdentifier: native.uniqueRequestIdentifier })
	return { type: 'result' as const, method: 'signer_reply' as const, result: '0x' }
	})
}
