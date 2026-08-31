import type * as funtypes from 'funtypes'
import { serialize } from '../types/wire-types.js'
import { Semaphore } from './semaphore.js'
import { assertNever } from './typescript.js'

export type LargeStateStorageKey = 'interceptorTransactionStack' | 'popupVisualisation' | 'safeTransactionStacks'

const LARGE_STATE_DB_NAME = 'interceptorLargeState'
const LARGE_STATE_STORE_NAME = 'largeState'
const LARGE_STATE_DELETE_MARKER_PREFIX = 'interceptorLargeStateDeleted:'
const LARGE_STATE_MIGRATED_MARKER_PREFIX = 'interceptorLargeStateMigrated:'

type IndexedDbLookup =
	| { kind: 'available', found: false }
	| { kind: 'available', found: true, value: unknown }
	| { kind: 'unavailable' }

type LegacyLocalLookup =
	| { kind: 'backup', value: unknown }
	| { kind: 'deleted' }
	| { kind: 'found', value: unknown }
	| { kind: 'missing' }

type LargeStateDeleteMarkerKey =
	| 'interceptorLargeStateDeleted:interceptorTransactionStack'
	| 'interceptorLargeStateDeleted:popupVisualisation'
	| 'interceptorLargeStateDeleted:safeTransactionStacks'

type LargeStateMigratedMarkerKey =
	| 'interceptorLargeStateMigrated:interceptorTransactionStack'
	| 'interceptorLargeStateMigrated:popupVisualisation'
	| 'interceptorLargeStateMigrated:safeTransactionStacks'

export type PreparedLargeStateWrite = {
	readonly key: LargeStateStorageKey
	readonly serializedValue: unknown
}

let indexedDbPromise: Promise<IDBDatabase | undefined> | undefined
let indexedDbSource: IDBFactory | undefined
let indexedDbOpenError: unknown
const largeStateSemaphore = new Semaphore(1)

function canUseIndexedDb() {
	return typeof indexedDB !== 'undefined'
}

async function openLargeStateDb() {
	if (!canUseIndexedDb()) return undefined
	if (indexedDbSource !== indexedDB) {
		indexedDbSource = indexedDB
		indexedDbPromise = undefined
		indexedDbOpenError = undefined
	}
	if (indexedDbPromise !== undefined) return indexedDbPromise
	const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(LARGE_STATE_DB_NAME, 1)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(LARGE_STATE_STORE_NAME)) db.createObjectStore(LARGE_STATE_STORE_NAME)
		}
		request.onsuccess = () => {
			indexedDbOpenError = undefined
			resolve(request.result)
		}
		request.onerror = () => reject(request.error ?? new Error('Failed to open large state IndexedDB database'))
		request.onblocked = () => reject(new Error('Large state IndexedDB database open was blocked'))
	})
	const retryableOpenPromise = openPromise.catch((error) => {
		console.warn('IndexedDB unavailable for large state persistence.')
		console.warn(error)
		indexedDbOpenError = error
		if (indexedDbPromise === retryableOpenPromise) indexedDbPromise = undefined
		return undefined
	})
	indexedDbPromise = retryableOpenPromise
	return indexedDbPromise
}

async function runIndexedDbRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
	const db = await openLargeStateDb()
	if (db === undefined) return { kind: 'unavailable' as const }
	return await new Promise<{ kind: 'available', value: T }>((resolve, reject) => {
		const transaction = db.transaction(LARGE_STATE_STORE_NAME, mode)
		const store = transaction.objectStore(LARGE_STATE_STORE_NAME)
		const request = operation(store)
		let requestResult: { value: T } | undefined
		request.onsuccess = () => {
			requestResult = { value: request.result }
		}
		request.onerror = () => reject(request.error ?? new Error(`Large state IndexedDB ${ mode } request failed`))
		transaction.oncomplete = () => {
			if (requestResult === undefined) {
				reject(new Error(`Large state IndexedDB ${ mode } transaction completed before the request succeeded`))
				return
			}
			resolve({ kind: 'available', value: requestResult.value })
		}
		transaction.onabort = () => reject(transaction.error ?? new Error(`Large state IndexedDB ${ mode } transaction aborted`))
		transaction.onerror = () => reject(transaction.error ?? new Error(`Large state IndexedDB ${ mode } transaction failed`))
	})
}

function warnIndexedDbRequestFailure(action: string, error: unknown, consequence = 'falling back to storage.local.') {
	console.warn(`IndexedDB ${ action } failed for large state persistence, ${ consequence }`)
	console.warn(error)
}

async function getIndexedDbValue(key: LargeStateStorageKey): Promise<IndexedDbLookup> {
	try {
		const result = await runIndexedDbRequest('readonly', (store) => store.get(key))
		if (result.kind === 'unavailable') {
			if (canUseIndexedDb()) throw indexedDbOpenError ?? new Error('IndexedDB unavailable while reading large state')
			return result
		}
		if (result.value === undefined) return { kind: 'available', found: false }
		return { kind: 'available', found: true, value: result.value }
	} catch (error) {
		warnIndexedDbRequestFailure('read', error, 'leaving the stored state unchanged.')
		throw error
	}
}

async function setIndexedDbValue(key: LargeStateStorageKey, value: unknown) {
	try {
		const result = await runIndexedDbRequest('readwrite', (store) => store.put(value, key))
		return result.kind === 'available'
	} catch (error) {
		warnIndexedDbRequestFailure('write', error)
		return false
	}
}

async function setIndexedDbValues(writes: readonly PreparedLargeStateWrite[]) {
	const db = await openLargeStateDb()
	if (db === undefined) return false
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(LARGE_STATE_STORE_NAME, 'readwrite')
			const store = transaction.objectStore(LARGE_STATE_STORE_NAME)
			for (const write of writes) {
				const request = store.put(write.serializedValue, write.key)
				request.onerror = () => reject(request.error ?? new Error(`Large state IndexedDB batch write failed for ${ write.key }`))
			}
			transaction.oncomplete = () => resolve()
			transaction.onabort = () => reject(transaction.error ?? new Error('Large state IndexedDB batch transaction aborted'))
			transaction.onerror = () => reject(transaction.error ?? new Error('Large state IndexedDB batch transaction failed'))
		})
		return true
	} catch (error) {
		warnIndexedDbRequestFailure('batch write', error)
		return false
	}
}

async function removeIndexedDbValue(key: LargeStateStorageKey) {
	try {
		const result = await runIndexedDbRequest('readwrite', (store) => store.delete(key))
		return result.kind === 'available'
	} catch (error) {
		warnIndexedDbRequestFailure('delete', error)
		return false
	}
}

function getLegacyDeleteMarkerKey(key: LargeStateStorageKey): LargeStateDeleteMarkerKey {
	switch (key) {
		case 'interceptorTransactionStack': return `${ LARGE_STATE_DELETE_MARKER_PREFIX }interceptorTransactionStack`
		case 'popupVisualisation': return `${ LARGE_STATE_DELETE_MARKER_PREFIX }popupVisualisation`
		case 'safeTransactionStacks': return `${ LARGE_STATE_DELETE_MARKER_PREFIX }safeTransactionStacks`
		default: return assertNever(key)
	}
}

function getLegacyMigratedMarkerKey(key: LargeStateStorageKey): LargeStateMigratedMarkerKey {
	switch (key) {
		case 'interceptorTransactionStack': return `${ LARGE_STATE_MIGRATED_MARKER_PREFIX }interceptorTransactionStack`
		case 'popupVisualisation': return `${ LARGE_STATE_MIGRATED_MARKER_PREFIX }popupVisualisation`
		case 'safeTransactionStacks': return `${ LARGE_STATE_MIGRATED_MARKER_PREFIX }safeTransactionStacks`
		default: return assertNever(key)
	}
}

async function getLegacyLocalLookup(key: LargeStateStorageKey): Promise<LegacyLocalLookup> {
	const deleteMarkerKey = getLegacyDeleteMarkerKey(key)
	const migratedMarkerKey = getLegacyMigratedMarkerKey(key)
	const localValue = await browser.storage.local.get([key, deleteMarkerKey, migratedMarkerKey])
	if (Object.prototype.hasOwnProperty.call(localValue, key) && localValue[migratedMarkerKey] === true && localValue[deleteMarkerKey] !== true) return { kind: 'backup', value: localValue[key] }
	if (Object.prototype.hasOwnProperty.call(localValue, key)) return { kind: 'found', value: localValue[key] }
	if (localValue[deleteMarkerKey] === true) return { kind: 'deleted' }
	return { kind: 'missing' }
}

async function removeLegacyLocalValue(key: LargeStateStorageKey) {
	await browser.storage.local.remove(key)
}

async function setLegacyLocalDeleted(key: LargeStateStorageKey) {
	await browser.storage.local.set({
		[getLegacyDeleteMarkerKey(key)]: true,
		[getLegacyMigratedMarkerKey(key)]: true,
	})
}

async function setLegacyLocalMigrated(key: LargeStateStorageKey) {
	await browser.storage.local.set({
		[getLegacyDeleteMarkerKey(key)]: false,
		[getLegacyMigratedMarkerKey(key)]: true,
	})
}

async function setLegacyLocalValues(writes: readonly PreparedLargeStateWrite[]) {
	const values: Record<string, unknown> = {}
	for (const write of writes) {
		values[write.key] = write.serializedValue
		values[getLegacyDeleteMarkerKey(write.key)] = false
		values[getLegacyMigratedMarkerKey(write.key)] = false
	}
	await browser.storage.local.set(values)
}

async function setLegacyLocalValuesMigrated(writes: readonly PreparedLargeStateWrite[]) {
	const values: Record<string, unknown> = {}
	for (const write of writes) {
		values[getLegacyDeleteMarkerKey(write.key)] = false
		values[getLegacyMigratedMarkerKey(write.key)] = true
	}
	await browser.storage.local.set(values)
}

function parseSerializedValue<T>(codec: funtypes.Codec<T>, value: unknown) {
	const parsed = codec.safeParse(value)
	return parsed.success ? parsed.value : undefined
}

async function getLargeStateValueUnlocked<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>): Promise<T | undefined> {
	const legacyLocalValue = await getLegacyLocalLookup(key)
	if (legacyLocalValue.kind === 'found') {
		const parsedLegacyValue = parseSerializedValue(codec, legacyLocalValue.value)
		if (parsedLegacyValue !== undefined) {
			const wasMigrated = await setIndexedDbValue(key, legacyLocalValue.value)
			if (wasMigrated) await setLegacyLocalMigrated(key)
			return parsedLegacyValue
		}
		await removeLegacyLocalValue(key)
	}
	if (legacyLocalValue.kind === 'deleted') {
		const wasRemoved = await removeIndexedDbValue(key)
		if (wasRemoved) await setLegacyLocalMigrated(key)
		return undefined
	}
	const indexedDbValue = await getIndexedDbValue(key)
	if (indexedDbValue.kind === 'available') {
		if (indexedDbValue.found) {
			const parsedIndexedDbValue = parseSerializedValue(codec, indexedDbValue.value)
			if (parsedIndexedDbValue !== undefined) return parsedIndexedDbValue
			await removeIndexedDbValue(key)
		}
	}
	return undefined
}

export async function getLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>): Promise<T | undefined> {
	return await largeStateSemaphore.execute(async () => await getLargeStateValueUnlocked(key, codec))
}

export async function setLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>, value: T) {
	await setLargeStateValues([prepareLargeStateWrite(key, codec, value)])
}

export function prepareLargeStateWrite<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>, value: T): PreparedLargeStateWrite {
	return { key, serializedValue: serialize(codec, value) }
}

async function setLargeStateValuesUnlocked(writes: readonly PreparedLargeStateWrite[]) {
	if (writes.length === 0) return
	if (new Set(writes.map(({ key }) => key)).size !== writes.length) throw new Error('Large state batch contains duplicate keys.')
	if (canUseIndexedDb()) {
		const wasStoredInIndexedDb = await setIndexedDbValues(writes)
		if (wasStoredInIndexedDb) {
			await setLegacyLocalValuesMigrated(writes)
			return
		}
	}
	await setLegacyLocalValues(writes)
}

export async function setLargeStateValues(writes: readonly PreparedLargeStateWrite[]) {
	await largeStateSemaphore.execute(async () => await setLargeStateValuesUnlocked(writes))
}

async function removeLargeStateValueUnlocked(key: LargeStateStorageKey) {
	if (!canUseIndexedDb()) {
		await removeLegacyLocalValue(key)
		await setLegacyLocalDeleted(key)
		return
	}
	const wasRemovedFromIndexedDb = await removeIndexedDbValue(key)
	if (wasRemovedFromIndexedDb) {
		await setLegacyLocalMigrated(key)
		return
	}
	await removeLegacyLocalValue(key)
	await setLegacyLocalDeleted(key)
}

export async function removeLargeStateValue(key: LargeStateStorageKey) {
	await largeStateSemaphore.execute(async () => await removeLargeStateValueUnlocked(key))
}

export function estimateSerializedStateBytes<T>(codec: funtypes.Codec<T>, value: T) {
	return new TextEncoder().encode(JSON.stringify(serialize(codec, value))).length
}

export function formatEstimatedBytes(bytes: number) {
	if (bytes < 1024) return `${ bytes } B`
	if (bytes < 1024 * 1024) return `${ (bytes / 1024).toFixed(1) } KiB`
	return `${ (bytes / (1024 * 1024)).toFixed(2) } MiB`
}
