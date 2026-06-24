import * as assert from 'assert'
import { afterEach, describe, test } from 'bun:test'
import { estimateSerializedStateBytes, formatEstimatedBytes, getLargeStateValue, removeLargeStateValue, setLargeStateValue } from '../../app/ts/utils/largeStateStore.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const stack: InterceptorTransactionStack = {
	operations: [{
		type: 'TimeManipulation',
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 11n, deltaUnit: 'Seconds' },
	}],
}

const staleStack: InterceptorTransactionStack = {
	operations: [{
		type: 'TimeManipulation',
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 7n, deltaUnit: 'Seconds' },
	}],
}

type StorageGetKeys = string | string[] | Record<string, unknown> | null | undefined

type FakeIndexedDbOptions = {
	readonly openErrors?: readonly Error[]
	readonly getError?: Error
	readonly putError?: Error
	readonly deleteError?: Error
	readonly putTransactionAbortAfterRequestSuccess?: Error
	readonly transactionError?: Error
}

type FakeRequest<T> = {
	error?: Error
	result: T
	onblocked?: () => void
	onerror?: () => void
	onsuccess?: () => void
	onupgradeneeded?: () => void
}

type FakeObjectStore = {
	delete: (key: string) => FakeRequest<undefined>
	get: (key: string) => FakeRequest<unknown>
	put: (value: unknown, key: string) => FakeRequest<string>
}

type FakeTransaction = {
	error?: Error
	onabort?: () => void
	oncomplete?: () => void
	onerror?: () => void
}

type FakeTransactionWithStore = FakeTransaction & {
	objectStore: () => FakeObjectStore
}

function createFakeRequest<T>(result: T): FakeRequest<T> {
	return { result }
}

function finishFakeRequest<T>(
	request: FakeRequest<T>,
	transaction: FakeTransaction,
	requestError: Error | undefined,
	transactionAbortAfterRequestSuccess: Error | undefined,
	pendingChange?: () => void,
) {
	queueMicrotask(() => {
		if (requestError !== undefined) {
			request.error = requestError
			request.onerror?.()
			return
		}
		request.onsuccess?.()
		queueMicrotask(() => {
			if (transactionAbortAfterRequestSuccess !== undefined) {
				transaction.error = transactionAbortAfterRequestSuccess
				transaction.onabort?.()
				return
			}
			pendingChange?.()
			transaction.oncomplete?.()
		})
	})
}

function createStorageGetResult(keys: StorageGetKeys, storageState: Record<string, unknown>) {
	if (keys === undefined || keys === null) return { ...storageState }
	if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
	if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
	return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
}

function installBrowserStorage(storageState: Record<string, unknown>) {
	Object.defineProperty(globalThis, 'browser', {
		value: {
			storage: {
				local: {
					async get(keys?: StorageGetKeys) {
						return createStorageGetResult(keys, storageState)
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
		},
		configurable: true,
		writable: true,
	})
}

function installFakeIndexedDb(indexedDbState: Map<string, unknown>, options: FakeIndexedDbOptions) {
	let hasLargeStateStore = false
	const fakeDb = {
		createObjectStore(_name: string) {
			hasLargeStateStore = true
			return undefined
		},
		objectStoreNames: {
			contains(_name: string) {
				return hasLargeStateStore
			},
		},
		transaction(_storeName: string, _mode: string) {
			if (options.transactionError !== undefined) throw options.transactionError
			let store: FakeObjectStore
			const transaction: FakeTransactionWithStore = {
				objectStore: () => store,
			}
			store = {
				get(key: string) {
					const request = createFakeRequest(indexedDbState.get(key))
					finishFakeRequest(request, transaction, options.getError, undefined)
					return request
				},
				put(value: unknown, key: string) {
					const request = createFakeRequest(key)
					finishFakeRequest(request, transaction, options.putError, options.putTransactionAbortAfterRequestSuccess, () => indexedDbState.set(key, value))
					return request
				},
				delete(key: string) {
					const request = createFakeRequest(undefined)
					finishFakeRequest(request, transaction, options.deleteError, undefined, () => indexedDbState.delete(key))
					return request
				},
			}
			return transaction
		},
	}
	let openAttemptCount = 0
	const fakeIndexedDb = {
		open(_name: string, _version?: number) {
			const request = createFakeRequest(fakeDb)
			const openError = options.openErrors?.[openAttemptCount]
			openAttemptCount += 1
			queueMicrotask(() => {
				if (openError !== undefined) {
					request.error = openError
					request.onerror?.()
					return
				}
				request.onupgradeneeded?.()
				request.onsuccess?.()
			})
			return request
		},
	}
	Object.defineProperty(globalThis, 'indexedDB', { value: fakeIndexedDb, configurable: true, writable: true })
	return fakeIndexedDb
}

function installLargeStateEnvironment(options: FakeIndexedDbOptions = {}) {
	const storageState: Record<string, unknown> = {}
	const indexedDbState = new Map<string, unknown>()
	installBrowserStorage(storageState)
	const fakeIndexedDb = installFakeIndexedDb(indexedDbState, options)
	return { fakeIndexedDb, indexedDbState, storageState }
}

function serializedStack(value: InterceptorTransactionStack = stack) {
	return serialize(InterceptorTransactionStack, value)
}

afterEach(() => {
	Object.defineProperty(globalThis, 'browser', { value: undefined, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
})

describe('large state store helpers', () => {
	test('estimate serialized bytes for persisted stack state', () => {
		const bytes = estimateSerializedStateBytes(InterceptorTransactionStack, stack)

		assert.equal(typeof bytes, 'number')
		assert.ok(bytes > 0)
	})

	test('format estimated byte sizes into readable units', () => {
		assert.equal(formatEstimatedBytes(512), '512 B')
		assert.equal(formatEstimatedBytes(2048), '2.0 KiB')
		assert.equal(formatEstimatedBytes(2 * 1024 * 1024), '2.00 MiB')
	})

	test('stores and reads large state from IndexedDB', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment()

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)
		assert.equal('interceptorTransactionStack' in storageState, false)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
	})

	test('falls back to storage.local when IndexedDB writes fail', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ putError: new Error('put failed') })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())
	})

	test('retries IndexedDB open after a transient open failure', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ openErrors: [new Error('open failed')] })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.equal('interceptorTransactionStack' in storageState, false)
	})

	test('reads storage.local fallback over stale IndexedDB after write failure', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ putError: new Error('put failed') })
		indexedDbState.set('interceptorTransactionStack', serializedStack(staleStack))

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack(staleStack))
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())
	})

	test('falls back to storage.local when IndexedDB write transaction aborts after request success', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ putTransactionAbortAfterRequestSuccess: new Error('commit failed') })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())
	})

	test('reads legacy storage.local when IndexedDB reads fail', async () => {
		const { storageState } = installLargeStateEnvironment({ getError: new Error('get failed') })
		storageState.interceptorTransactionStack = serializedStack()

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
	})

	test('keeps legacy storage.local value when IndexedDB migration writes fail', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ putError: new Error('put failed') })
		storageState.interceptorTransactionStack = serializedStack()

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())
	})

	test('keeps legacy storage.local value when IndexedDB migration transaction aborts after request success', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ putTransactionAbortAfterRequestSuccess: new Error('commit failed') })
		storageState.interceptorTransactionStack = serializedStack()

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(storageState.interceptorTransactionStack, serializedStack())
	})

	test('removes legacy storage.local value when IndexedDB deletes fail', async () => {
		const { indexedDbState, storageState } = installLargeStateEnvironment({ deleteError: new Error('delete failed') })
		indexedDbState.set('interceptorTransactionStack', serializedStack())
		storageState.interceptorTransactionStack = serializedStack()

		await removeLargeStateValue('interceptorTransactionStack')

		assert.equal('interceptorTransactionStack' in storageState, false)
		assert.equal(storageState['interceptorLargeStateDeleted:interceptorTransactionStack'], true)
		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), undefined)
	})

	test('keeps stale IndexedDB hidden when large state is removed during an IndexedDB outage', async () => {
		const { fakeIndexedDb, indexedDbState, storageState } = installLargeStateEnvironment()
		indexedDbState.set('interceptorTransactionStack', serializedStack())
		storageState.interceptorTransactionStack = serializedStack()
		Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })

		await removeLargeStateValue('interceptorTransactionStack')

		assert.equal('interceptorTransactionStack' in storageState, false)
		assert.equal(storageState['interceptorLargeStateDeleted:interceptorTransactionStack'], true)

		Object.defineProperty(globalThis, 'indexedDB', { value: fakeIndexedDb, configurable: true, writable: true })

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), undefined)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.equal('interceptorLargeStateDeleted:interceptorTransactionStack' in storageState, false)
	})

	test('falls back to storage.local when IndexedDB transactions fail', async () => {
		const { storageState } = installLargeStateEnvironment({ transactionError: new Error('transaction failed') })
		storageState.interceptorTransactionStack = serializedStack()

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
	})
})
