import * as funtypes from 'funtypes'
import { DirectSigningRecords, type DirectSigningRecord } from '../types/directSigning.js'
import { signingOperationError } from './signingOperationError.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { getPendingTransactionsAndMessages } from '../background/storageVariables.js'

/** Corrupt signing history must remain available for recovery, especially after ambiguous submission. */
export async function readDirectSigningRecords(): Promise<readonly DirectSigningRecord[]> {
	try {
		return (await browserStorageLocalGet('directSigningRequestsV1')).directSigningRequestsV1 ?? []
	} catch (error) {
		if (!(error instanceof funtypes.ValidationError)) throw error
		const { reportUnexpectedError } = await import('../utils/errors.js')
		await reportUnexpectedError(error, { source: 'direct_signing_storage', code: 'direct_signing_records_corrupt', displayMessage: 'Saved signing requests are corrupt. Existing data was preserved; signing is blocked until recovery.' })
		throw error
	}
}

const directSigningRecordsLock = new Semaphore(1)

export type DirectSigningRecordsTransaction = {
	read: typeof readDirectSigningRecords
	store: (record: DirectSigningRecord) => Promise<DirectSigningRecord>
}

/** Serialize the complete read/check/write lifecycle, including durable writes before network submission. */
export async function withDirectSigningRecords<T>(update: (transaction: DirectSigningRecordsTransaction) => Promise<T>): Promise<T> {
	return await directSigningRecordsLock.execute(async () => {
		let active = true
		const writes = new Semaphore(1)
		try {
			return await update({
				read: async () => {
					if (!active) throw new Error('Signing storage transaction has ended')
					return await readDirectSigningRecords()
				},
				store: async (record) => await writes.execute(async () => {
					if (!active) throw new Error('Signing storage transaction has ended')
					return await persistDirectSigningRecord(record)
				}),
			})
		} finally {
			active = false
			// Drain any started write before releasing the aggregate lock.
			await writes.execute(async () => undefined)
		}
	})
}

export async function storeDirectSigningRecord(record: DirectSigningRecord) {
	return await withDirectSigningRecords(async (transaction) => await transaction.store(record))
}

/** Retain ambiguous submissions and bounded recent history inside a storage transaction. */
async function persistDirectSigningRecord(record: DirectSigningRecord) {
	const records = await readDirectSigningRecords()
	const pending = await getPendingTransactionsAndMessages()
	const retained = records.filter((item) => item.id !== record.id && (item.phase === 'submitting' || pending.some((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, item.request))))
	const history = records.filter((item) => item.id !== record.id && !retained.includes(item) && ['submitted', 'confirmed', 'cancelled'].includes(item.phase)).slice(-4)
	const next = [...history, ...retained, record]
	const serialized = DirectSigningRecords.serialize(next)
	if (next.length > 16 || new TextEncoder().encode(JSON.stringify(serialized)).length > 4 * 1024 * 1024) throw signingOperationError('Too many saved signing requests. Finish or cancel pending signing requests before continuing.')
	await browserStorageLocalSet({ directSigningRequestsV1: next })
	return record
}

