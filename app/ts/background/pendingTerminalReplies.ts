import type { StoredTerminalReply } from '../types/interceptor-messages.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'

const pendingTerminalRepliesSemaphore = new Semaphore(1)

export async function getPendingTerminalReplies(): Promise<readonly StoredTerminalReply[]> {
	const parsedStorage = await browserStorageLocalSafeParseGet('pendingTerminalReplies')
	if (parsedStorage !== undefined) return parsedStorage.pendingTerminalReplies ?? []
	const validationError = new Error('Stored pending terminal replies failed runtime validation.')
	await browserStorageLocalSet({ pendingTerminalReplies: [] })
	await reportLocalRecovery(validationError, {
		source: 'pending_terminal_replies',
		code: 'pending_terminal_replies_corrupt',
		message: 'Discarded corrupt pending terminal replies so wallet requests can continue.',
	})
	return []
}

async function updatePendingTerminalReplies(update: (pendingReplies: readonly StoredTerminalReply[]) => readonly StoredTerminalReply[]) {
	return await pendingTerminalRepliesSemaphore.execute(async () => {
		const pendingTerminalReplies = update(await getPendingTerminalReplies())
		await browserStorageLocalSet({ pendingTerminalReplies })
		return pendingTerminalReplies
	})
}

// Stores the reply as its request's commitment, unless the request already has one, which is kept: a request is committed to one reply. Returns the stored commitment.
export async function commitPendingTerminalReply(reply: StoredTerminalReply) {
	const pendingReplies = await updatePendingTerminalReplies((pendingReplies) => pendingReplies.some((pendingReply) => doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier))
		? pendingReplies
		: [...pendingReplies, reply])
	const committed = pendingReplies.find((pendingReply) => doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier))
	if (committed === undefined) throw new Error('The committed terminal reply is missing')
	return committed
}

export async function markPendingTerminalReplyDelivered(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.map((reply) => doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier) ? { ...reply, delivered: true } : reply))
}

// Records the window that shows the entry's request, for an entry stored without it, before the request is removed.
export async function rememberPendingTerminalReplyWindow(uniqueRequestIdentifier: UniqueRequestIdentifier, confirmationWindow: PopupOrTabId) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.map((reply) => doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier) ? { ...reply, confirmationWindow } : reply))
}

// Drops the entry's confirmation window once the window was updated after its request was removed.
export async function forgetPendingTerminalReplyWindow(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.map((reply) => {
		if (!doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier)) return reply
		const { confirmationWindow: _confirmationWindow, ...withoutWindow } = reply
		return withoutWindow
	}))
}

export async function removePendingTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((reply) => !doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier)))
}
