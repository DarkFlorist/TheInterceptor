import type * as funtypes from 'funtypes'
import { serialize } from '../types/wire-types.js'
import { assertNever } from './typescript.js'

export type LargeStateStorageKey = 'interceptorTransactionStack' | 'popupVisualisation'

const LARGE_STATE_DB_NAME = 'interceptorLargeState'
const LARGE_STATE_STORE_NAME = 'largeState'
const LARGE_STATE_DELETE_MARKER_PREFIX = 'interceptorLargeStateDeleted:'

type IndexedDbLookup =
	| { kind: 'available', found: false }
	| { kind: 'available', found: true, value: unknown }
	| { kind: 'unavailable' }

type LegacyLocalLookup =
	| { kind: 'deleted' }
	| { kind: 'found', value: unknown }
	| { kind: 'missing' }

type LargeStateDeleteMarkerKey =
	| 'interceptorLargeStateDeleted:interceptorTransactionStack'
	| 'interceptorLargeStateDeleted:popupVisualisation'

let indexedDbPromise: Promise<IDBDatabase | undefined> | undefined 
let indexedDbSource: IDBFactory | undefined 

function canUseIndexedDb() {
	return typeof indexedDB !== 'undefined'
}

async function openLargeStateDb() {
	if (!canUseIndexedDb()) return undefined
	if (indexedDbSource !== indexedDB) {
		indexedDbSource = indexedDB
		indexedDbPromise = undefined
	}
	if (indexedDbPromise !== undefined) return indexedDbPromise
	indexedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(LARGE_STATE_DB_NAME, 1)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(LARGE_STATE_STORE_NAME)) db.createObjectStore(LARGE_STATE_STORE_NAME)
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error('Failed to open large state IndexedDB database'))
		request.onblocked = () => reject(new Error('Large state IndexedDB database open was blocked'))
	}).catch((error) => {
		console.warn('IndexedDB unavailable for large state persistence, falling back to storage.local.')
		console.warn(error)
		return undefined
	})
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

function warnIndexedDbRequestFailure(action: string, error: unknown) {
	console.warn(`IndexedDB ${ action } failed for large state persistence, falling back to storage.local.`)
	console.warn(error)
}

async function getIndexedDbValue(key: LargeStateStorageKey): Promise<IndexedDbLookup> {
	try {
		const result = await runIndexedDbRequest('readonly', (store) => store.get(key))
		if (result.kind === 'unavailable') return result
		if (result.value === undefined) return { kind: 'available', found: false }
		return { kind: 'available', found: true, value: result.value }
	} catch (error) {
		warnIndexedDbRequestFailure('read', error)
		return { kind: 'unavailable' }
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
		default: return assertNever(key)
	}
}

async function getLegacyLocalLookup(key: LargeStateStorageKey): Promise<LegacyLocalLookup> {
	const deleteMarkerKey = getLegacyDeleteMarkerKey(key)
	const localValue = await browser.storage.local.get([key, deleteMarkerKey])
	if (Object.prototype.hasOwnProperty.call(localValue, key)) return { kind: 'found', value: localValue[key] }
	if (localValue[deleteMarkerKey] === true) return { kind: 'deleted' }
	return { kind: 'missing' }
}

async function removeLegacyLocalValue(key: LargeStateStorageKey) {
	await browser.storage.local.remove(key)
}

async function clearLegacyLocalState(key: LargeStateStorageKey) {
	await browser.storage.local.remove([key, getLegacyDeleteMarkerKey(key)])
}

async function setLegacyLocalDeleted(key: LargeStateStorageKey) {
	await browser.storage.local.set({ [getLegacyDeleteMarkerKey(key)]: true })
}

async function setLegacyLocalValue(key: LargeStateStorageKey, value: unknown) {
	await browser.storage.local.set({ [key]: value })
	await browser.storage.local.remove(getLegacyDeleteMarkerKey(key))
}

function parseSerializedValue<T>(codec: funtypes.Codec<T>, value: unknown) {
	const parsed = codec.safeParse(value)
	return parsed.success ? parsed.value : undefined
}

export async function getLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>): Promise<T | undefined> {
	const legacyLocalValue = await getLegacyLocalLookup(key)
	if (legacyLocalValue.kind === 'found') {
		const parsedLegacyValue = parseSerializedValue(codec, legacyLocalValue.value)
		if (parsedLegacyValue !== undefined) {
			const wasMigrated = await setIndexedDbValue(key, legacyLocalValue.value)
			if (wasMigrated) await clearLegacyLocalState(key)
			return parsedLegacyValue
		}
		await removeLegacyLocalValue(key)
	}
	if (legacyLocalValue.kind === 'deleted') {
		const wasRemoved = await removeIndexedDbValue(key)
		if (wasRemoved) await clearLegacyLocalState(key)
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

export async function setLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>, value: T) {
	const serializedValue = serialize(codec, value)
	if (canUseIndexedDb()) {
		const wasStoredInIndexedDb = await setIndexedDbValue(key, serializedValue)
		if (wasStoredInIndexedDb) {
			await clearLegacyLocalState(key)
			return
		}
	}
	await setLegacyLocalValue(key, serializedValue)
}

export async function removeLargeStateValue(key: LargeStateStorageKey) {
	if (!canUseIndexedDb()) {
		await removeLegacyLocalValue(key)
		await setLegacyLocalDeleted(key)
		return
	}
	const wasRemovedFromIndexedDb = await removeIndexedDbValue(key)
	if (wasRemovedFromIndexedDb) {
		await clearLegacyLocalState(key)
		return
	}
	await removeLegacyLocalValue(key)
	await setLegacyLocalDeleted(key)
}

export function estimateSerializedStateBytes<T>(codec: funtypes.Codec<T>, value: T) {
	return new TextEncoder().encode(JSON.stringify(serialize(codec, value))).length
}

export function formatEstimatedBytes(bytes: number) {
	if (bytes < 1024) return `${ bytes } B`
	if (bytes < 1024 * 1024) return `${ (bytes / 1024).toFixed(1) } KiB`
	return `${ (bytes / (1024 * 1024)).toFixed(2) } MiB`
}
