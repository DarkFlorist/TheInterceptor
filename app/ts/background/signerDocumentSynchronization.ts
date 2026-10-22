import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { INTERCEPTOR_SIGNER_DOCUMENT_PROBE_METHOD } from '../utils/inpageBridgeProtocol.js'
import { isMissingBrowserTargetError, type WebsiteSocket } from '../utils/requests.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { getSignerDocumentGenerationForOrigin, isCurrentChildSignerSocket } from './signerExecutionAuthority.js'

type ChildSignerDocumentProbe =
	| { readonly status: 'ready', readonly generation: string }
	| { readonly status: 'retry' | 'ineligible' }

const getProbeOrigin = (reply: unknown) => typeof reply === 'object' && reply !== null && 'origin' in reply && typeof reply.origin === 'string' ? reply.origin : undefined

// Browser-routed messages target the active documents. Firefox isolates each frame's expandos, so document identity stays in closures rather than on window.top.
export async function probeChildSignerDocument(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, frameId: number): Promise<ChildSignerDocumentProbe> {
	const generation = getSignerDocumentGenerationForOrigin(websiteTabConnections, socket.tabId, websiteOrigin)
	if (generation === undefined || !isCurrentChildSignerSocket(websiteTabConnections, socket, frameId)) return { status: 'retry' }
	try {
		const [topReply, childReply]: unknown[] = await Promise.all([
			browser.tabs.sendMessage(socket.tabId, { method: INTERCEPTOR_SIGNER_DOCUMENT_PROBE_METHOD, signerDocumentGeneration: generation }, { frameId: 0 }),
			browser.tabs.sendMessage(socket.tabId, { method: INTERCEPTOR_SIGNER_DOCUMENT_PROBE_METHOD, connectionName: serialize(EthereumQuantity, socket.connectionName) }, { frameId }),
		])
		if (generation !== getSignerDocumentGenerationForOrigin(websiteTabConnections, socket.tabId, websiteOrigin) || !isCurrentChildSignerSocket(websiteTabConnections, socket, frameId)) return { status: 'retry' }
		const topOrigin = getProbeOrigin(topReply)
		const childOrigin = getProbeOrigin(childReply)
		if (topOrigin === undefined || childOrigin === undefined) return { status: 'retry' }
		if (topOrigin === 'null' || childOrigin !== topOrigin) return { status: 'ineligible' }
		return { status: 'ready', generation }
	} catch (error: unknown) {
		if (isMissingBrowserTargetError(error) || (error instanceof Error && isIgnorablePortLifecycleError(error))) return { status: 'retry' }
		throw error
	}
}
