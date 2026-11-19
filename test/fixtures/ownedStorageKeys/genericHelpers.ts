import { browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../../../app/ts/utils/storageUtils.js'

// The generic storage helpers type-check for a generic key, and refuse both keys that the pending-request storage transaction owns.
export async function useGenericStorageHelpers() {
	await browserStorageLocalSet({ simulationMode: true })
	const items = await browserStorageLocalGet('simulationMode')
	await browserStorageLocalSet({ pendingTerminalReplies: [] }) // expect-type-error
	await browserStorageLocalSet({ pendingTransactionsAndMessages: [] }) // expect-type-error
	await browserStorageLocalGet('pendingTerminalReplies') // expect-type-error
	await browserStorageLocalGet('pendingTransactionsAndMessages') // expect-type-error
	await browserStorageLocalSafeParseGet('pendingTerminalReplies') // expect-type-error
	await browserStorageLocalSafeParseGet('pendingTransactionsAndMessages') // expect-type-error
	await browserStorageLocalRemove('pendingTerminalReplies') // expect-type-error
	await browserStorageLocalRemove('pendingTransactionsAndMessages') // expect-type-error
	return [items.simulationMode, items.pendingTerminalReplies, items.pendingTransactionsAndMessages] // expect-type-error
}
