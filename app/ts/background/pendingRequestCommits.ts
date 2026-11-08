// How a pending request's outcome is committed: the commit lock that a rejection and an approval's final commits share, the reply a request gets, and rejection itself. It needs no simulation or window code, so a rejection can never wait for either.
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

const pendingTransactionOrMessageCommitScope = {}
const serializePendingTransactionOrMessageCommit = createScopedKeyedSerialExecutor<typeof pendingTransactionOrMessageCommitScope, string>()

// Preparing an approval can take as long as an RPC does, and a rejection or a closed window must not wait for that, so a rejection takes only this lock. Everything that decides a request's outcome runs under it on what is stored right then: whichever commits first wins, a later commit finds the request gone and does nothing, and so a request gets one reply and is not forwarded after it was rejected. A commit needs no RPC, as a rejection waits for it. It is separate from the lock of a resolution, which keeps two approvals of one request from preparing at the same time.
export async function commitIfStillPending<T>(uniqueRequestIdentifier: UniqueRequestIdentifier, commit: (stored: PendingTransactionOrSignableMessage) => Promise<T>): Promise<PendingRequestCommit<T>> {
	return await serializePendingTransactionOrMessageCommit(pendingTransactionOrMessageCommitScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async () => {
		const stored = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		return stored === undefined ? { stored: false } : { stored: true, result: await commit(stored) }
	})
}

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
	const committed = await commitIfStillPending(uniqueRequestIdentifier, async (stored) => {
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
