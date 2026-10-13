import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { estimateSerializedStateBytes, formatEstimatedBytes, getLargeStateValue, prepareLargeStateWrite, removeLargeStateValue, setLargeStateValue, setLargeStateValues } from '../../app/ts/utils/largeStateStore.js'
import { CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation, InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { getPopupVisualisationState, updateInterceptorTransactionStack, updatePopupVisualisationWithCallBack, updateTransactionState } from '../../app/ts/background/storageVariables.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { SafeTransactionStacks } from '../../app/ts/types/safeTypes.js'
import { updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { replaceGlobal } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { createStubEthereumClient } from './stubEthereumClient.js'

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

const transactionStackDeleteMarkerKey = 'interceptorLargeStateDeleted:interceptorTransactionStack'
const transactionStackMigratedMarkerKey = 'interceptorLargeStateMigrated:interceptorTransactionStack'
const safeStacksMigratedMarkerKey = 'interceptorLargeStateMigrated:safeTransactionStacks'
const popupVisualisationMigratedMarkerKey = 'interceptorLargeStateMigrated:popupVisualisation'

const { installBrowserMockForTest, restoreAfterTest } = createPerTestRestorer()

type FakeIndexedDbOptions = {
	readonly openErrors?: readonly Error[]
	readonly getError?: Error
	readonly getErrorKey?: string
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
					finishFakeRequest(request, transaction, options.getErrorKey === undefined || options.getErrorKey === key ? options.getError : undefined, undefined)
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
	restoreAfterTest(replaceGlobal('indexedDB', fakeIndexedDb))
}

type LargeStateEnvironmentOptions = {
	readonly indexedDb?: FakeIndexedDbOptions
	readonly localStorage?: Readonly<Record<string, unknown>>
	readonly beforeLocalStorageSet?: (items: Readonly<Record<string, unknown>>) => Promise<void>
}

function installLargeStateEnvironment({ indexedDb = {}, localStorage = {}, beforeLocalStorageSet }: LargeStateEnvironmentOptions = {}) {
	const indexedDbState = new Map<string, unknown>()
	const browserMock = installBrowserMockForTest({ storage: { local: localStorage } })
	if (beforeLocalStorageSet !== undefined) {
		const setWithoutHook = browserMock.browser.storage.local.set
		browserMock.browser.storage.local.set = async (items) => {
			await beforeLocalStorageSet(items)
			await setWithoutHook(items)
		}
	}
	installFakeIndexedDb(indexedDbState, indexedDb)
	return {
		indexedDbState,
		readLocalStorage: () => browserMock.readStorage(),
		readLocalItem: (key: string) => browserMock.readStorage()[key],
		hasLocalItem: (key: string) => Object.hasOwn(browserMock.readStorage(), key),
	}
}

function serializedStack(value: InterceptorTransactionStack = stack) {
	return serialize(InterceptorTransactionStack, value)
}

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
		const { indexedDbState, hasLocalItem, readLocalItem } = installLargeStateEnvironment()

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)
		assert.equal(hasLocalItem('interceptorTransactionStack'), false)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
	})

	test('stores transaction and Safe stacks in one IndexedDB batch', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment()

		await setLargeStateValues([
			prepareLargeStateWrite('interceptorTransactionStack', InterceptorTransactionStack, stack),
			prepareLargeStateWrite('safeTransactionStacks', SafeTransactionStacks, []),
		])

		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(indexedDbState.get('safeTransactionStacks'), [])
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
		assert.equal(readLocalItem(safeStacksMigratedMarkerKey), true)
	})

	test('does not let a fallback read overwrite a newly committed IndexedDB batch', async () => {
		const markerWriteRelease = Promise.withResolvers<void>()
		const markerWriteStart = Promise.withResolvers<void>()
		const { indexedDbState } = installLargeStateEnvironment({
			localStorage: {
				interceptorTransactionStack: serializedStack(staleStack),
				[transactionStackMigratedMarkerKey]: false,
			},
			beforeLocalStorageSet: async (items) => {
				if (items[transactionStackMigratedMarkerKey] !== true) return
				markerWriteStart.resolve()
				await markerWriteRelease.promise
			},
		})

		const write = setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)
		await markerWriteStart.promise
		const concurrentRead = getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)
		markerWriteRelease.resolve()

		await write
		assert.deepEqual(await concurrentRead, stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
	})

	test('falls back with both transaction-state records when an IndexedDB batch fails', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { putError: new Error('put failed') } })

		await setLargeStateValues([
			prepareLargeStateWrite('interceptorTransactionStack', InterceptorTransactionStack, stack),
			prepareLargeStateWrite('safeTransactionStacks', SafeTransactionStacks, []),
		])

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.equal(indexedDbState.has('safeTransactionStacks'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalItem('safeTransactionStacks'), [])
	})

	test('falls back to storage.local when IndexedDB writes fail', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { putError: new Error('put failed') } })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
	})

	test('retries IndexedDB open after a transient open failure', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { openErrors: [new Error('open failed')] } })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
	})

	test('reads storage.local fallback over stale IndexedDB after write failure', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { putError: new Error('put failed') } })
		indexedDbState.set('interceptorTransactionStack', serializedStack(staleStack))

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack(staleStack))
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
	})

	test('preserves legacy storage.local backup after a successful migration', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: { interceptorTransactionStack: serializedStack() } })

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
	})

	test('reads IndexedDB over a migrated storage.local backup after newer writes', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: { interceptorTransactionStack: serializedStack(staleStack) } })

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), staleStack)

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack(staleStack))
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
	})

	test('clears the migration marker when writes fall back to storage.local', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: { interceptorTransactionStack: serializedStack(staleStack) } })

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), staleStack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack(staleStack))
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)

		const endIndexedDbOutage = replaceGlobal('indexedDB', undefined)

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), false)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), false)

		endIndexedDbOutage()

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
	})

	test('fallback writes overwrite stale marker values in one storage.local write', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: {
			[transactionStackDeleteMarkerKey]: true,
			[transactionStackMigratedMarkerKey]: true,
		} })
		indexedDbState.set('interceptorTransactionStack', serializedStack(staleStack))
		const endIndexedDbOutage = replaceGlobal('indexedDB', undefined)

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), false)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), false)

		endIndexedDbOutage()

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
	})

	test('reads an authoritative local value over a stale delete marker from earlier fallback writes', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: {
			interceptorTransactionStack: serializedStack(),
			[transactionStackDeleteMarkerKey]: true,
			[transactionStackMigratedMarkerKey]: false,
		} })
		indexedDbState.set('interceptorTransactionStack', serializedStack(staleStack))

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), false)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
	})

	test('falls back to storage.local when IndexedDB write transaction aborts after request success', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { putTransactionAbortAfterRequestSuccess: new Error('commit failed') } })

		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stack)

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
	})

	test('reads legacy storage.local when IndexedDB reads fail', async () => {
		installLargeStateEnvironment({ indexedDb: { getError: new Error('get failed') }, localStorage: { interceptorTransactionStack: serializedStack() } })

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
	})

	test('rejects IndexedDB read failures instead of returning a stale migrated backup', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({
			indexedDb: { getError: new Error('get failed') },
			localStorage: {
				interceptorTransactionStack: serializedStack(staleStack),
				[transactionStackMigratedMarkerKey]: true,
			},
		})
		indexedDbState.set('interceptorTransactionStack', serializedStack())

		await assert.rejects(
			getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack),
			/get failed/,
		)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack(staleStack))
	})

	test('rejects IndexedDB open failures when state is not authoritative in storage.local', async () => {
		const { indexedDbState } = installLargeStateEnvironment({
			indexedDb: { openErrors: [new Error('open failed')] },
			localStorage: { [transactionStackMigratedMarkerKey]: true },
		})
		indexedDbState.set('interceptorTransactionStack', serializedStack())

		await assert.rejects(
			getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack),
			/open failed/,
		)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
	})

	for (const failure of ['read', 'open']) {
		test(`preserves persisted popup visualisation when IndexedDB ${ failure } fails`, async () => {
			const error = new Error(`popup ${ failure } failed`)
			const { indexedDbState, readLocalStorage } = installLargeStateEnvironment({
				indexedDb: failure === 'read' ? { getError: error } : { openErrors: [error] },
				localStorage: { [popupVisualisationMigratedMarkerKey]: true },
			})
			const savedResults = createPassthroughCompleteVisualizedSimulation(77, 'done', 2)
			const serializedResults = serialize(CompleteVisualizedSimulation, savedResults)
			indexedDbState.set('popupVisualisation', serializedResults)
			const previousLocalState = readLocalStorage()

			await assert.rejects(getPopupVisualisationState(), (caught: unknown) => caught === error)
			assert.deepEqual(indexedDbState.get('popupVisualisation'), serializedResults)
			assert.deepEqual(readLocalStorage(), previousLocalState)

			// A later successful read must still return the saved results, not an empty replacement.
			installFakeIndexedDb(indexedDbState, {})
			assert.deepEqual(await getPopupVisualisationState(), savedResults)
		})
	}

	for (const key of ['interceptorTransactionStack', 'safeTransactionStacks']) {
		test(`aborts transaction-state updates when ${ key } cannot be read`, async () => {
			const error = new Error('read failed')
			const { indexedDbState } = installLargeStateEnvironment({
				indexedDb: { getError: error },
				localStorage: key === 'safeTransactionStacks' ? { interceptorTransactionStack: serializedStack() } : {},
			})
			if (key !== 'safeTransactionStacks') {
				indexedDbState.set('interceptorTransactionStack', serializedStack())
			}
			await assert.rejects(updateTransactionState(() => assert.fail('must not update unreadable state')), (caught: unknown) => caught === error)
			if (key === 'interceptorTransactionStack') {
				await assert.rejects(updateInterceptorTransactionStack(() => assert.fail('must not update unreadable stack')), (caught: unknown) => caught === error)
			}
			assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
			assert.equal(indexedDbState.has('safeTransactionStacks'), false)
		})
	}

	test('aborts popup updates when the previous visualisation cannot be read', async () => {
		const error = new Error('read failed')
		const { indexedDbState, readLocalStorage } = installLargeStateEnvironment({ indexedDb: { getError: error } })
		const savedResults = serialize(CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation(77, 'done', 2))
		indexedDbState.set('popupVisualisation', savedResults)

		await assert.rejects(updatePopupVisualisationWithCallBack(async () => assert.fail('must not update unreadable visualisation')), (caught: unknown) => caught === error)
		assert.deepEqual(indexedDbState.get('popupVisualisation'), savedResults)
		assert.deepEqual(readLocalStorage(), {})
	})

	test('preserves popup results when simulation refresh cannot read the transaction stack', async () => {
		const error = new Error('transaction stack read failed')
		const { indexedDbState, readLocalStorage } = installLargeStateEnvironment({ indexedDb: { getError: error, getErrorKey: 'interceptorTransactionStack' } })
		const savedResults = serialize(CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation(77, 'done', 2))
		indexedDbState.set('popupVisualisation', savedResults)
		indexedDbState.set('interceptorTransactionStack', serializedStack())
		const rpcNetwork: RpcEntry = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://ethereum.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const ethereum = createStubEthereumClient(async () => assert.fail('must not simulate an unreadable stack'), rpcNetwork)

		await assert.rejects(updatePopupVisualisationState(ethereum, new TokenPriceService(ethereum, 0), undefined, true), (caught: unknown) => caught === error)
		assert.deepEqual(indexedDbState.get('popupVisualisation'), savedResults)
		assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		assert.deepEqual(readLocalStorage(), {})
	})

	for (const operation of ['write', 'delete']) {
		test(`rejects ${ operation } when the local fallback cannot persist the operation`, async () => {
			const error = new Error('local persistence failed')
			const { indexedDbState } = installLargeStateEnvironment({
				indexedDb: { putError: new Error('put failed'), deleteError: new Error('delete failed') },
				beforeLocalStorageSet: async () => { throw error },
			})
			indexedDbState.set('interceptorTransactionStack', serializedStack())

			await assert.rejects(
				operation === 'write'
					? setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, staleStack)
					: removeLargeStateValue('interceptorTransactionStack'),
				(caught: unknown) => caught === error,
			)
			assert.deepEqual(indexedDbState.get('interceptorTransactionStack'), serializedStack())
		})
	}

	test('keeps legacy storage.local value when IndexedDB migration writes fail', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ indexedDb: { putError: new Error('put failed') }, localStorage: { interceptorTransactionStack: serializedStack() } })

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
	})

	test('keeps legacy storage.local value when IndexedDB migration transaction aborts after request success', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({
			indexedDb: { putTransactionAbortAfterRequestSuccess: new Error('commit failed') },
			localStorage: { interceptorTransactionStack: serializedStack() },
		})

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
	})

	test('removes legacy storage.local value when IndexedDB deletes fail', async () => {
		const { indexedDbState, hasLocalItem, readLocalItem } = installLargeStateEnvironment({ indexedDb: { deleteError: new Error('delete failed') }, localStorage: { interceptorTransactionStack: serializedStack() } })
		indexedDbState.set('interceptorTransactionStack', serializedStack())

		await removeLargeStateValue('interceptorTransactionStack')

		assert.equal(hasLocalItem('interceptorTransactionStack'), false)
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), true)
		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), undefined)
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), true)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
	})

	test('preserves the migrated storage.local backup after IndexedDB deletes succeed', async () => {
		const { indexedDbState, readLocalItem } = installLargeStateEnvironment({ localStorage: { interceptorTransactionStack: serializedStack() } })

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), stack)

		await removeLargeStateValue('interceptorTransactionStack')

		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.deepEqual(readLocalItem('interceptorTransactionStack'), serializedStack())
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), undefined)
	})

	test('keeps stale IndexedDB hidden when large state is removed during an IndexedDB outage', async () => {
		const { indexedDbState, hasLocalItem, readLocalItem } = installLargeStateEnvironment({ localStorage: { interceptorTransactionStack: serializedStack() } })
		indexedDbState.set('interceptorTransactionStack', serializedStack())
		const endIndexedDbOutage = replaceGlobal('indexedDB', undefined)

		await removeLargeStateValue('interceptorTransactionStack')

		assert.equal(hasLocalItem('interceptorTransactionStack'), false)
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), true)

		endIndexedDbOutage()

		assert.deepEqual(await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack), undefined)
		assert.equal(indexedDbState.has('interceptorTransactionStack'), false)
		assert.equal(readLocalItem(transactionStackDeleteMarkerKey), false)
		assert.equal(readLocalItem(transactionStackMigratedMarkerKey), true)
	})

	test('falls back to storage.local when IndexedDB transactions fail', async () => {
		installLargeStateEnvironment({ indexedDb: { transactionError: new Error('transaction failed') }, localStorage: { interceptorTransactionStack: serializedStack() } })

		const value = await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack)

		assert.deepEqual(value, stack)
	})
})
