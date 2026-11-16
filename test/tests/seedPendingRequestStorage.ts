import * as funtypes from 'funtypes'
import { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const StoredPendingRequests = funtypes.ReadonlyArray(PendingTransactionOrSignableMessage)

// Puts a test's starting state in storage directly, including states no production path produces. Production writes this key only through storageVariables.ts.
export async function seedPendingRequestStorage({ pendingTransactionsAndMessages }: { readonly pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[] }) {
	await browser.storage.local.set({ pendingTransactionsAndMessages: serialize(StoredPendingRequests, pendingTransactionsAndMessages) })
}
