import * as funtypes from 'funtypes'
import { serialize } from '../types/wire-types.js'

export type LargeStateStorageKey = 'interceptorTransactionStack' | 'popupVisualisation'

const LARGE_STATE_DB_NAME = 'interceptorLargeState'
const LARGE_STATE_STORE_NAME = 'largeState'

type IndexedDbLookup =
	| { kind: 'available', found: false }
	| { kind: 'available', found: true, value: unknown }
	| { kind: 'unavailable' }

let indexedDbPromise: Promise<IDBDatabase | undefined> | undefined = undefined
let indexedDbSource: IDBFactory | undefined = undefined

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
		request.onsuccess = () => resolve({ kind: 'available', value: request.result })
		request.onerror = () => reject(request.error ?? new Error(`Large state IndexedDB ${ mode } request failed`))
		transaction.onabort = () => reject(transaction.error ?? new Error(`Large state IndexedDB ${ mode } transaction aborted`))
	})
}

async function getIndexedDbValue(key: LargeStateStorageKey): Promise<IndexedDbLookup> {
	const result = await runIndexedDbRequest('readonly', (store) => store.get(key))
	if (result.kind === 'unavailable') return result
	if (result.value === undefined) return { kind: 'available', found: false }
	return { kind: 'available', found: true, value: result.value }
}

async function setIndexedDbValue(key: LargeStateStorageKey, value: unknown) {
	const result = await runIndexedDbRequest('readwrite', (store) => store.put(value, key))
	return result.kind === 'available'
}

async function removeIndexedDbValue(key: LargeStateStorageKey) {
	const result = await runIndexedDbRequest('readwrite', (store) => store.delete(key))
	return result.kind === 'available'
}

async function getLegacyLocalValue(key: LargeStateStorageKey) {
	const localValue = await browser.storage.local.get(key)
	if (!Object.prototype.hasOwnProperty.call(localValue, key)) return undefined
	return localValue[key]
}

async function removeLegacyLocalValue(key: LargeStateStorageKey) {
	await browser.storage.local.remove(key)
}

async function setLegacyLocalValue(key: LargeStateStorageKey, value: unknown) {
	await browser.storage.local.set({ [key]: value })
}

function parseSerializedValue<T>(codec: funtypes.Codec<T>, value: unknown) {
	const parsed = codec.safeParse(value)
	return parsed.success ? parsed.value : undefined
}

export async function getLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>): Promise<T | undefined> {
	const indexedDbValue = await getIndexedDbValue(key)
	if (indexedDbValue.kind === 'available') {
		if (indexedDbValue.found) {
			const parsedIndexedDbValue = parseSerializedValue(codec, indexedDbValue.value)
			if (parsedIndexedDbValue !== undefined) return parsedIndexedDbValue
			await removeIndexedDbValue(key)
		}
		const legacyLocalValue = await getLegacyLocalValue(key)
		if (legacyLocalValue === undefined) return undefined
		const parsedLegacyValue = parseSerializedValue(codec, legacyLocalValue)
		if (parsedLegacyValue === undefined) {
			await removeLegacyLocalValue(key)
			return undefined
		}
		try {
			await setIndexedDbValue(key, legacyLocalValue)
			await removeLegacyLocalValue(key)
		} catch (error) {
			console.warn(`Failed to migrate ${ key } to IndexedDB.`)
			console.warn(error)
		}
		return parsedLegacyValue
	}
	const localValue = await getLegacyLocalValue(key)
	if (localValue === undefined) return undefined
	const parsedLocalValue = parseSerializedValue(codec, localValue)
	if (parsedLocalValue !== undefined) return parsedLocalValue
	await removeLegacyLocalValue(key)
	return undefined
}

export async function setLargeStateValue<T>(key: LargeStateStorageKey, codec: funtypes.Codec<T>, value: T) {
	const serializedValue = serialize(codec, value)
	if (canUseIndexedDb()) {
		const wasStoredInIndexedDb = await setIndexedDbValue(key, serializedValue)
		if (wasStoredInIndexedDb) {
			await removeLegacyLocalValue(key)
			return
		}
	}
	await setLegacyLocalValue(key, serializedValue)
}

export async function removeLargeStateValue(key: LargeStateStorageKey) {
	if (canUseIndexedDb()) await removeIndexedDbValue(key)
	await removeLegacyLocalValue(key)
}

export function estimateSerializedStateBytes<T>(codec: funtypes.Codec<T>, value: T) {
	return new TextEncoder().encode(JSON.stringify(serialize(codec, value))).length
}

export function formatEstimatedBytes(bytes: number) {
	if (bytes < 1024) return `${ bytes } B`
	if (bytes < 1024 * 1024) return `${ (bytes / 1024).toFixed(1) } KiB`
	return `${ (bytes / (1024 * 1024)).toFixed(2) } MiB`
}
