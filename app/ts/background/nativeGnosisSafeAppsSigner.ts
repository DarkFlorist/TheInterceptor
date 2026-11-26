import { NATIVE_GNOSIS_SAFE_APPS_SIGNER_CALLBACK, parseNativeGnosisSafeAppsSignerReplyToken, parseNativeGnosisSafeAppsSignerRequest } from '../../shared/ts/nativeGnosisSafeAppsSignerProtocol.js'
import { serializeInpageReply, type InterceptedRequestForward, type SignerReply, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getActiveAddress, getWebsiteSocketConnection, getSocketFromPort, websiteSocketToString } from './backgroundUtils.js'
import { getNativeGnosisSafeAppsChildLaunch, getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'
import { getConfirmedSignerStateToken, isSignerStateTokenCurrent, signerConnectionReplacedError, type SignerStateToken } from './signerStateOwnership.js'
import { doesUniqueRequestIdentifiersMatch, getTabIfExists } from '../utils/requests.js'
import { getSettings } from './settings.js'
import { hasAccess, hasAddressAccess } from './websiteAccessPolicy.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { getNativeGnosisSafeAppsSession } from './nativeGnosisSafeAppsSessions.js'

type SignerForward = Extract<InterceptedRequestForward, { readonly type: 'forwardToSigner' }>
type Connection = NonNullable<ReturnType<typeof getWebsiteSocketConnection>>
type PendingNativeSignerRequest = { readonly forward: SignerForward, readonly host: Connection, readonly signer: SignerStateToken }
type SignerResult = SignerReply['params'][0]
const pendingByConnections = new WeakMap<WebsiteTabConnections, Map<string, PendingNativeSignerRequest>>()

function matchesHost(connections: WebsiteTabConnections, host: Connection, signer: SignerStateToken) {
	const child = getWebsiteSocketConnection(connections, signer.socket)
	const launch = getNativeGnosisSafeAppsChildLaunch(signer.port.sender)
	const hostLaunch = getNativeGnosisSafeAppsHostLaunch(host.port.sender)
	const session = getNativeGnosisSafeAppsSession(connections, host.socket.tabId)
	return child?.nativeGnosisSafeAppsSigner === true && child.port === signer.port && host.nativeGnosisSafeAppOrigin !== undefined
		&& child.nativeGnosisSafeAppsHostPort === host.port && session?.port === host.port && session.origin === host.nativeGnosisSafeAppOrigin
		&& host.socket.tabId === signer.socket.tabId && launch?.appUrl.origin === host.nativeGnosisSafeAppOrigin
		&& hostLaunch?.appUrl.href === launch?.appUrl.href && child.websiteOrigin === host.websiteOrigin
		&& getWebsiteSocketConnection(connections, host.socket) === host
}

// Registration marks only browser-verified direct children. Ordinary approved iframes cannot become signer owners.
export function isNativeGnosisSafeAppsSignerPort(connections: WebsiteTabConnections, port: browser.runtime.Port) {
	const socket = getSocketFromPort(port)
	if (socket === undefined) return false
	const connection = getWebsiteSocketConnection(connections, socket)
	if (connection?.port !== port || connection.nativeGnosisSafeAppsSigner !== true) return false
	const launch = getNativeGnosisSafeAppsChildLaunch(port.sender)
	const session = getNativeGnosisSafeAppsSession(connections, socket.tabId)
	return launch !== undefined && connection.websiteOrigin === launch.appUrl.host && session?.origin === launch.appUrl.origin && connection.nativeGnosisSafeAppsHostPort === session.port
}

// The host owns request identity and approvals; only the selected child's real wallet provider receives the signer callback.
export function forwardNativeGnosisSafeAppsSignerRequest(connections: WebsiteTabConnections, forward: SignerForward, send: (port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) => boolean) {
	const host = getWebsiteSocketConnection(connections, forward.uniqueRequestIdentifier.requestSocket)
	const signer = getConfirmedSignerStateToken(connections, forward.uniqueRequestIdentifier.requestSocket.tabId)
	if (host === undefined || signer === undefined || !host.approved || !matchesHost(connections, host, signer)) return false
	let pending = pendingByConnections.get(connections)
	if (pending === undefined) { pending = new Map(); pendingByConnections.set(connections, pending) }
	const requestKey = `${ websiteSocketToString(host.socket) }-${ forward.uniqueRequestIdentifier.requestId }`
	for (const [token, value] of pending) {
		const previousKey = `${ websiteSocketToString(value.host.socket) }-${ value.forward.uniqueRequestIdentifier.requestId }`
		if (previousKey === requestKey || !isSignerStateTokenCurrent(connections, value.signer) || !matchesHost(connections, value.host, value.signer)) pending.delete(token)
	}
	if (pending.size >= 40) return false
	const token = crypto.randomUUID()
	const wire = serializeInpageReply({ ...forward, interceptorApproved: true, requestId: forward.uniqueRequestIdentifier.requestId })
	const payload = parseNativeGnosisSafeAppsSignerRequest({ token, signerProviderGeneration: signer.signerProviderGeneration, request: wire })
	if (payload === undefined) throw new Error('Cannot serialize the approved Gnosis Safe App signer request.')
	pending.set(token, { forward, host, signer })
	const sent = send(signer.port, { type: 'result', method: NATIVE_GNOSIS_SAFE_APPS_SIGNER_CALLBACK, result: payload })
	if (!sent) pending.delete(token)
	return sent
}

// A reply supplies only an unguessable correlation token; host request identifiers and methods always come from the captured approval.
export async function takeNativeGnosisSafeAppsSignerReply(connections: WebsiteTabConnections, port: browser.runtime.Port, result: SignerResult) {
	const token = parseNativeGnosisSafeAppsSignerReplyToken('params' in result.forwardRequest ? result.forwardRequest.params : undefined)
	if (token === undefined) return undefined
	const pending = pendingByConnections.get(connections)
	const captured = pending?.get(token)
	if (captured === undefined || captured.signer.port !== port) return undefined
	pending?.delete(token)
	const { host, signer, forward } = captured
	const frameId = signer.port.sender?.frameId
	const settings = await getSettings()
	const approval = (await getPendingTransactionsAndMessages()).find((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, forward.uniqueRequestIdentifier))
	const address = approval === undefined ? undefined : (await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)).find((entry) => entry.address === approval.activeAddress)
	const selectedAddress = approval === undefined ? undefined : await getActiveAddress(settings, host.socket.tabId)
	const reviewedChain = approval?.transactionOrMessageCreationStatus !== 'Simulated' ? undefined : approval.type === 'SignableMessage' ? approval.visualizedPersonalSignRequest.rpcNetwork.chainId : approval.transactionToSimulate.transaction.chainId
	// Read browser bindings and current preferences after the asynchronous account lookup, then make the final decision without another await.
	const [tab, frame, latestSettings] = await Promise.all([getTabIfExists(host.socket.tabId), frameId === undefined ? undefined : browser.webNavigation.getFrame({ tabId: signer.socket.tabId, frameId }), getSettings()])
	const access = approval === undefined ? hasAccess(latestSettings.websiteAccess, host.websiteOrigin) : address === undefined ? 'noAccess' : hasAddressAccess(latestSettings.websiteAccess, host.websiteOrigin, address)
	const approvalIsCurrent = approval === undefined || (!latestSettings.simulationMode && approval.approvalStatus.status === 'WaitingForSigner' && selectedAddress?.address === approval.activeAddress && latestSettings.activeSigningSafeAddress === approval.activeAddress && reviewedChain === latestSettings.activeRpcNetwork.chainId)
	const current = isSignerStateTokenCurrent(connections, signer) && result.signerProviderGeneration === signer.signerProviderGeneration
		&& matchesHost(connections, host, signer) && tab?.url === host.port.sender?.url
		&& frame?.parentFrameId === 0 && new URL(frame.url).origin === host.nativeGnosisSafeAppOrigin
		&& host.approved && access === 'hasAccess' && approvalIsCurrent
	const reply = current ? result : { ...result, success: false as const, error: signerConnectionReplacedError }
	return { uniqueRequestIdentifier: forward.uniqueRequestIdentifier, reply, forward }
}
