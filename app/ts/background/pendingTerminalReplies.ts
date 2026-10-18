import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { browserStorageLocalGet2Result, browserStorageLocalSafeParseGet, browserStorageLocalSet, browserStorageLocalSetPendingAndTerminalState } from '../utils/storageUtils.js'
import { pendingRequestTerminalStateSemaphore } from './terminalStateSemaphore.js'
import { modifyObject } from '../utils/typescript.js'

export async function getPendingTerminalReplies(): Promise<readonly InterceptedRequestForward[]> {
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

async function updatePendingTerminalReplies(update: (pendingReplies: readonly InterceptedRequestForward[]) => readonly InterceptedRequestForward[]) {
	return await pendingRequestTerminalStateSemaphore.execute(async () => {
		const pendingTerminalReplies = update(await getPendingTerminalReplies())
		await browserStorageLocalSet({ pendingTerminalReplies })
		return pendingTerminalReplies
	})
}

export async function appendPendingTerminalReply(reply: InterceptedRequestForward) {
	await updatePendingTerminalReplies((pendingReplies) => [
		...pendingReplies.filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier)),
		reply,
	])
}

export async function queueDeferredSafeProposalTerminalReply(
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	signerReply: string,
	reply: InterceptedRequestForward,
) {
	await pendingRequestTerminalStateSemaphore.execute(async () => {
		const pendingResult = await browserStorageLocalGet2Result('pendingTransactionsAndMessages')
		if (!pendingResult.success) throw pendingResult.error
		const pendingTransactions = pendingResult.value.pendingTransactionsAndMessages ?? []
		const pendingIndex = pendingTransactions.findIndex((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (pendingIndex < 0) return
		const pending = pendingTransactions[pendingIndex]
		if (pending === undefined) return
		const pendingReplies = await getPendingTerminalReplies()
		await browserStorageLocalSetPendingAndTerminalState(
			pendingTransactions.map((entry, index) => index === pendingIndex
				? modifyObject(entry, { deferredSafeSignerReply: { signerReply, terminalReplyQueued: true } })
				: entry
			),
			[...pendingReplies.filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, uniqueRequestIdentifier)), reply],
		)
	})
}

export async function removePendingTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((reply) => !doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier)))
}

export async function removePendingTerminalRepliesForTab(tabId: number) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((reply) => reply.uniqueRequestIdentifier.requestSocket.tabId !== tabId))
}

export async function prunePendingTerminalRepliesForMissingTabs() {
	const pendingReplies = await getPendingTerminalReplies()
	const tabIds = [...new Set(pendingReplies.map((reply) => reply.uniqueRequestIdentifier.requestSocket.tabId))]
	const missingTabIds = new Set<number>()
	for (const tabId of tabIds) {
		if (!await doesTabExist(tabId)) missingTabIds.add(tabId)
	}
	if (missingTabIds.size === 0) return 0
	const remainingReplies = await updatePendingTerminalReplies((replies) => replies.filter((reply) => !missingTabIds.has(reply.uniqueRequestIdentifier.requestSocket.tabId)))
	return pendingReplies.length - remainingReplies.length
}
