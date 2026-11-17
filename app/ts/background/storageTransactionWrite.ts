import type { LocalStorageItems } from '../utils/storageUtils.js'

export type StorageCommitBoundary = (commit: () => Promise<void>) => Promise<void>
const preparedWriteData: unique symbol = Symbol('prepared storage write')
export type PreparedStorageWrite = {
	readonly [preparedWriteData]: { readonly items: LocalStorageItems, readonly boundary?: StorageCommitBoundary }
}

// Storage owners may wrap the single atomic commit with their own consistency boundary.
export const prepareStorageTransactionWrite = (items: LocalStorageItems, boundary?: StorageCommitBoundary): PreparedStorageWrite => ({ [preparedWriteData]: { items, boundary } })
export const isPreparedStorageWrite = (write: object): write is PreparedStorageWrite => preparedWriteData in write
export const getPreparedStorageWrite = (write: PreparedStorageWrite) => write[preparedWriteData]
