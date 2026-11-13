// The one owner of a pending request's two locks, how its outcome is committed, the reply it gets, and rejection itself. The locks are private, and the only ways to take them are resolveSerially and commitOnly, so their order is set here: a resolution takes the resolution lock and takes the commit lock only for each of its commits, through the commit step it is given, and a rejection or a closed window takes only the commit lock. It needs no simulation or window code, so a rejection can never wait for either.
import * as funtypes from 'funtypes'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import { METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'
import { createScopedKeyedSerialExecutor } from '../utils/semaphore.js'
import { getPendingTransactionsAndMessages, removePendingTransactionOrMessage } from './storageVariables.js'
import { attemptQueuedTerminalReplyDelivery, queueTerminalReply, queueTerminalReplyAndAttemptDelivery } from './terminalReplyDelivery.js'

export type PendingRequestCommit<T> = { readonly stored: false } | { readonly stored: true, readonly result: T }

export const getPendingTransactionOrMessageByidentifier = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return (await getPendingTransactionsAndMessages()).find((tx) => doesUniqueRequestIdentifiersMatch(tx.uniqueRequestIdentifier, uniqueRequestIdentifier))
}

const pendingRequestLockScope = {}
const runUnderResolutionLock = createScopedKeyedSerialExecutor<typeof pendingRequestLockScope, string>()
const runUnderCommitLock = createScopedKeyedSerialExecutor<typeof pendingRequestLockScope, string>()

// A commit on the request as it is stored right then, under the commit lock. Whichever commit comes first wins, and a later one finds the request gone and does nothing, so a request gets one reply and is not forwarded after it was rejected. A commit reads and writes storage and posts to a port, but never awaits an RPC, as a rejection waits for it; it is given no services, and the resolutions, which hold them, run their RPCs before they commit. A caller whose commit may only complete a request in a particular state passes mayCommit, which is checked on the stored request under the lock, and a request it refuses is treated as one that is gone.
export type CommitToStoredRequest = <T>(commit: (stored: PendingTransactionOrSignableMessage) => Promise<T>, mayCommit?: (stored: PendingTransactionOrSignableMessage) => boolean) => Promise<PendingRequestCommit<T>>

const commitStepFor = (uniqueRequestIdentifier: UniqueRequestIdentifier): CommitToStoredRequest => async (commit, mayCommit = () => true) => await runUnderCommitLock(pendingRequestLockScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async () => {
	const stored = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
	return stored === undefined || !mayCommit(stored) ? { stored: false } : { stored: true, result: await commit(stored) }
})

// Approvals and signer replies of one request can overlap, for example when duplicate confirmation windows both approve it or a double click sends two approvals. They run one at a time under the resolution lock on freshly read state, so a later approval sees that the first one already forwarded the request to the signer, or added it to the simulation stack and removed it. Preparing can take as long as an RPC does, so resolve commits only through the commit step it is given, which takes the commit lock for just that commit; a rejection never waits for the preparation. A request that is no longer stored is not resolved.
export async function resolveSerially<T>(uniqueRequestIdentifier: UniqueRequestIdentifier, resolve: (stored: PendingTransactionOrSignableMessage, commit: CommitToStoredRequest) => Promise<T>): Promise<T | undefined> {
	return await runUnderResolutionLock(pendingRequestLockScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async () => {
		const stored = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (stored === undefined) return undefined
		return await resolve(stored, commitStepFor(uniqueRequestIdentifier))
	})
}

// A commit that does not wait for a resolution being prepared, which is how a rejection or a closed window answers at once. It takes only the commit lock.
export const commitOnly = async <T>(uniqueRequestIdentifier: UniqueRequestIdentifier, commit: (stored: PendingTransactionOrSignableMessage) => Promise<T>) => await commitStepFor(uniqueRequestIdentifier)(commit)

export type TerminalReplyContent = { readonly type: 'result', readonly error: { readonly code: number, readonly message: string } } | { readonly type: 'result', readonly result: unknown }

export function createTerminalReply(pending: PendingTransactionOrSignableMessage, uniqueRequestIdentifier: UniqueRequestIdentifier, content: TerminalReplyContent): InterceptedRequestForward {
	if ('error' in content) return { ...pending.originalRequestParameters, ...content, uniqueRequestIdentifier }
	if (pending.originalRequestParameters.method === 'eth_sendRawTransaction' || pending.originalRequestParameters.method === 'eth_sendTransaction') return { ...pending.originalRequestParameters, ...content, result: EthereumBytes32.parse(content.result), uniqueRequestIdentifier }
	return { ...pending.originalRequestParameters, ...content, result: funtypes.String.parse(content.result), uniqueRequestIdentifier }
}

// Gives the request its reply: once the reply is queued and the request is out of the confirmation queue, a restart leaves at most the reply's delivery. Called from a commit, and the delivery comes after the commit, as a delivery can wait for a reconnect.
export async function queueTerminalReplyAndRemovePendingRequest(terminalReply: InterceptedRequestForward, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await queueTerminalReply(terminalReply)
	await removePendingTransactionOrMessage(uniqueRequestIdentifier)
}

// A rejection commits without waiting for an approval that is still being prepared. A request is rejected the same way whatever its state, also while the wallet has it. A closed window's request stays stored until its reply is delivered, so a failed cleanup of the reply can be retried without posting it again. The window work after it needs an RPC, so onRemoved only lets the caller schedule it for once the websites have their answers.
export async function cancelPendingTransactionOrMessage(websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, action: 'reject' | 'noResponse', onRemoved: (removed: PendingTransactionOrSignableMessage) => void) {
	const committed = await commitOnly(uniqueRequestIdentifier, async (stored) => {
		if (action === 'noResponse') {
			const delivery = await queueTerminalReplyAndAttemptDelivery(websiteTabConnections, createTerminalReply(stored, uniqueRequestIdentifier, formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature')))
			await removePendingTransactionOrMessage(uniqueRequestIdentifier)
			return { stored, deliver: async () => delivery }
		}
		const content = stored.transactionOrMessageCreationStatus === 'Simulated'
			? formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature')
			: formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
		const terminalReply = createTerminalReply(stored, uniqueRequestIdentifier, content)
		await queueTerminalReplyAndRemovePendingRequest(terminalReply, uniqueRequestIdentifier)
		return { stored, deliver: async () => await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply) }
	})
	if (!committed.stored) return undefined
	onRemoved(committed.result.stored)
	return await committed.result.deliver()
}


export const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}
