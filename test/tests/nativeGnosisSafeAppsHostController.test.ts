import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../../app/ts/utils/nativeGnosisSafeAppsHostTiming.js'
import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createNativeGnosisSafeAppsHostController } from '../../app/ts/components/pages/nativeGnosisSafeAppsHostController.js'
import type { NativeGnosisSafeAppsRequest, NativeGnosisSafeAppsResponse } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'

const request = (id: string, method: string): NativeGnosisSafeAppsRequest => ({ id, method, env: { sdkVersion: '9.1.0' } })
const metadata = (address = 'current'): NativeGnosisSafeAppsResponse => ({ id: 'prepare', success: true, data: { safeAddress: address } })

function hostHarness() {
	let now = 0
	let nextTimer = 0
	let reloads = 0
	let prepare: () => Promise<NativeGnosisSafeAppsResponse> = async () => metadata()
	const timers = new Map<number, { callback: () => void, at: number, repeat?: number }>()
	const requests: NativeGnosisSafeAppsRequest[] = []
	const replies: NativeGnosisSafeAppsResponse[] = []
	const pending = new Map<string, ReturnType<typeof Promise.withResolvers<NativeGnosisSafeAppsResponse>>>()
	const controller = createNativeGnosisSafeAppsHostController({
		appUrl: 'https://app.example/swap',
		request: async (value) => {
			requests.push(value)
			if (value.id === 'prepare') return await prepare()
			const deferred = Promise.withResolvers<NativeGnosisSafeAppsResponse>()
			pending.set(value.id, deferred)
			return await deferred.promise
		},
		postResponse: (response) => { replies.push(response) },
		reload: () => { reloads++ },
		now: () => now,
		schedule: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return () => { timers.delete(id) } },
		repeat: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay, repeat: delay }); return () => { timers.delete(id) } },
	})
	return {
		controller, requests, replies, pending, timers,
		get reloads() { return reloads },
		setPreparation: (next: () => Promise<NativeGnosisSafeAppsResponse>) => { prepare = next },
		advance: (elapsed: number) => {
			now += elapsed
			for (const [id, timer] of [...timers]) if (timer.at <= now) {
				if (timer.repeat === undefined) timers.delete(id)
				else timer.at = now + timer.repeat
				timer.callback()
			}
		},
	}
}

test('one derived retry guard blocks both the UI and programmatic retry until every admitted mutation finishes', async () => {
	const host = hostHarness()
	await host.controller.refresh()
	const first = host.controller.receive(request('first', 'sendTransactions'))
	const second = host.controller.receive(request('second', 'signMessage'))
	assert.equal(host.controller.retryDisabled.value, true)
	assert.equal(host.controller.retry(), false)
	assert.equal(host.reloads, 0)
	host.pending.get('first')?.resolve({ id: 'first', success: true })
	await first
	assert.equal(host.controller.retryDisabled.value, true)
	assert.equal(host.controller.retry(), false)
	host.pending.get('second')?.resolve({ id: 'second', success: true })
	await second
	assert.equal(host.controller.retryDisabled.value, false)
	assert.equal(host.controller.retry(), true)
	assert.equal(host.reloads, 1)
	assert.deepEqual(host.replies.map(({ id }) => id), ['first', 'second'])
})

for (const success of [true, false]) test(`context changes retain the original frame for a pending mutation's ${ success ? 'successful' : 'rejected' } terminal reply without replay`, async () => {
	const host = hostHarness()
	await host.controller.refresh()
	const originalFrame = host.controller.view.value.frameGeneration
	const operation = host.controller.receive(request('operation', 'sendTransactions'))
	host.controller.invalidateContext(['simulationMode'])
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	assert.equal(host.controller.view.value.frameGeneration, originalFrame)
	assert.equal(host.controller.retry(), false)
	await host.controller.receive(request('new-operation', 'sendTransactions'))
	assert.equal(host.requests.some(({ id }) => id === 'new-operation'), false)
	assert.equal(host.replies[0]?.success, false)
	const terminal = { id: 'operation', success, ...(success ? { data: { safeTxHash: 'result' } } : { error: 'User rejected the request' }) }
	host.pending.get('operation')?.resolve(terminal)
	await operation
	assert.equal(host.controller.view.value.frameGeneration, originalFrame)
	assert.deepEqual(host.replies.filter(({ id }) => id === 'operation'), [terminal])
	assert.equal(host.requests.filter(({ id }) => id === 'operation').length, 1)
	assert.equal(host.controller.retryDisabled.value, false)
	assert.match(host.controller.view.value.status, /Pending requests finished/)
})

test('wallet changes suppress stale discovery and require reconnection before the app can act with a new selection', async () => {
	const host = hostHarness()
	host.controller.start()
	await host.controller.refresh()
	const originalFrame = host.controller.view.value.frameGeneration
	const discovery = host.controller.receive(request('old-chain', 'getChainInfo'))
	host.setPreparation(async () => metadata('new-wallet'))
	host.controller.invalidateContext(['activeSigningSafeAddress'])
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameGeneration, originalFrame, 'Changing wallet context must retain the live signer iframe')
	host.pending.get('old-chain')?.resolve({ id: 'old-chain', success: true, data: { chainId: 'old-chain' } })
	await discovery
	assert.deepEqual(host.replies, [], 'A discovery started under old settings cannot publish after invalidation')
	await host.controller.receive(request('fresh-info', 'getSafeInfo'))
	assert.equal(host.replies[0]?.success, false, 'The old app must not silently act with a newly selected wallet')
	assert.equal(host.requests.some(({ id }) => id === 'fresh-info'), false)
	assert.equal(host.controller.view.value.connectionError, true)
	assert.match(host.controller.view.value.status, /Retry/)
	assert.equal(host.controller.retry(), true)
	assert.equal(host.reloads, 1)

	host.controller.stop()
})

test('revocation clears metadata while retaining the signer frame and cancels the old handshake deadline', async () => {
	const host = hostHarness()
	host.controller.start()
	await host.controller.refresh()
	const generation = host.controller.view.value.frameGeneration
	host.setPreparation(async () => ({ id: 'prepare', success: false, error: 'Website permission revoked' }))
	host.controller.invalidateContext(['websiteAccess'])
	await host.controller.refresh()
	host.advance(NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs + 1)
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	assert.equal(host.controller.view.value.frameGeneration, generation)
	assert.equal(host.controller.view.value.status, 'Website permission revoked')
	const denied = host.controller.receive(request('revoked-info', 'getSafeInfo'))
	assert.ok(host.pending.has('revoked-info'), 'Revocation removes cached metadata; the background must explicitly refuse the current request')
	host.pending.get('revoked-info')?.resolve({ id: 'revoked-info', success: false, error: 'Website permission revoked' })
	await denied
	assert.equal(host.replies.at(-1)?.success, false)
	host.controller.stop()
})

test('a superseded preparation cannot cache or display metadata from the old wallet', async () => {
	const host = hostHarness()
	const oldPreparation = Promise.withResolvers<NativeGnosisSafeAppsResponse>()
	host.setPreparation(async () => await oldPreparation.promise)
	const refreshing = host.controller.refresh()
	host.controller.invalidateContext(['websiteAccess'])
	host.setPreparation(async () => metadata('current-wallet'))
	oldPreparation.resolve(metadata('old-wallet'))
	await refreshing
	await host.controller.refresh()
	await host.controller.receive(request('info', 'getSafeInfo'))
	assert.deepEqual(host.replies[0]?.data, { safeAddress: 'current-wallet' })
	assert.equal(host.requests.filter(({ id }) => id === 'prepare').length, 2)
})

test('closing the host disposes its timers and prevents late replies or retries', async () => {
	const host = hostHarness()
	host.controller.start()
	await host.controller.refresh()
	const operation = host.controller.receive(request('operation', 'sendTransactions'))
	assert.equal(host.timers.size, 1, 'The SDK handshake clears its deadline, leaving only refresh scheduling')
	host.controller.stop()
	assert.equal(host.timers.size, 0)
	host.pending.get('operation')?.resolve({ id: 'operation', success: true })
	await operation
	assert.deepEqual(host.replies, [])
	assert.equal(host.controller.retry(), false)
})


test('native hosting loads the real iframe before waiting for signer-dependent metadata', async () => {
	const host = hostHarness()
	const preparation = Promise.withResolvers<NativeGnosisSafeAppsResponse>()
	host.setPreparation(async () => await preparation.promise)
	host.controller.start()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	assert.deepEqual(host.requests, [], 'Starting the frame must not deadlock behind metadata that requires its signer bridge')
	const refreshing = host.controller.refresh()
	preparation.resolve(metadata('prepared-wallet'))
	await refreshing
	assert.equal(host.controller.view.value.frameGeneration, 1, 'Preparation must not recreate the iframe')
	await host.controller.receive(request('sdk-discovery', 'getSafeInfo'))
	assert.deepEqual(host.requests.map(({ id }) => id), ['prepare'])
	assert.deepEqual(host.replies, [{ ...metadata('prepared-wallet'), id: 'sdk-discovery' }])
	host.controller.stop()
})

for (const failure of ['transport', 'RPC']) test(`${ failure } metadata refresh failure and recovery preserve the loaded app session`, async () => {
	const host = hostHarness()
	host.controller.start()
	await host.controller.refresh()
	await host.controller.receive(request('initial-info', 'getSafeInfo'))
	const frame = host.controller.view.value
	host.setPreparation(async () => {
		if (failure === 'transport') throw new TypeError('Extension connection temporarily unavailable')
		return { id: 'prepare', success: false, error: 'Simulation RPC temporarily unavailable' }
	})
	host.advance(NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs)
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, frame.frameUrl)
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration)
	assert.match(host.controller.view.value.status, /temporarily unavailable/)
	assert.equal(host.controller.view.value.connectionError, true, 'Actionable refresh errors must be visible in the minimal controls')
	await host.controller.receive(request('cached-info', 'getSafeInfo'))
	assert.deepEqual(host.replies.at(-1), { ...metadata(), id: 'cached-info' })
	assert.equal(host.requests.length, 2, 'a failed refresh preserves the still-fresh prepared response')
	host.setPreparation(async () => metadata('refreshed-wallet'))
	host.advance(NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs)
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration, 'recovery must not remount the iframe')
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.match(host.controller.view.value.status, /Wallet information refreshed/)
	assert.equal(host.controller.view.value.connectionError, false, 'Recovered healthy sessions can collapse their connection controls')
	await host.controller.receive(request('refreshed-info', 'getSafeInfo'))
	assert.deepEqual(host.replies.at(-1), { ...metadata('refreshed-wallet'), id: 'refreshed-info' })
	assert.equal(host.reloads, 0)
	host.controller.stop()
})

test('failed refreshes do not extend the prepared metadata lifetime', async () => {
	const host = hostHarness()
	await host.controller.refresh()
	host.setPreparation(async () => { throw new Error('Temporary refresh failure') })
	host.advance(NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.preparedMetadataLifetimeMs - 1)
	await host.controller.refresh()
	host.advance(1)
	await host.controller.receive(request('boundary-info', 'getSafeInfo'))
	assert.equal(host.pending.has('boundary-info'), false, 'prepared metadata remains usable at its exact lifetime boundary')
	assert.deepEqual(host.replies.at(-1), { ...metadata(), id: 'boundary-info' })
	host.advance(1)
	const discovery = host.controller.receive(request('expired-info', 'getSafeInfo'))
	assert.ok(host.pending.has('expired-info'), 'expired cached metadata must use a newly admitted request despite the preserved iframe')
	host.pending.get('expired-info')?.resolve({ id: 'expired-info', success: false, error: 'Metadata temporarily unavailable' })
	await discovery
	assert.equal(host.replies.at(-1)?.success, false)
	assert.equal(host.controller.view.value.frameHidden, false)
})

test('failed initial preparation keeps the app and its wallet bridge loaded while exposing a retryable error', async () => {
	const host = hostHarness()
	host.controller.start()
	for (const prepare of [
		async (): Promise<NativeGnosisSafeAppsResponse> => { throw new TypeError('Initial extension connection unavailable') },
		async (): Promise<NativeGnosisSafeAppsResponse> => ({ id: 'prepare', success: false, error: 'Initial RPC unavailable' }),
		async (): Promise<NativeGnosisSafeAppsResponse> => ({ id: 'prepare', success: true, data: { safeAddress: 42 } }),
	]) {
		host.setPreparation(prepare)
		await host.controller.refresh()
		assert.equal(host.controller.view.value.frameHidden, false)
		assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
		assert.equal(host.controller.view.value.frameGeneration, 1)
		assert.notEqual(host.controller.view.value.status, 'Preparing your selected Gnosis Safe…')
		assert.equal(host.controller.view.value.connectionError, true)
	}
	host.setPreparation(async () => metadata())
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameGeneration, 1)
	assert.equal(host.controller.retry(), true)
	assert.equal(host.reloads, 1)
	host.controller.stop()
})

test('a transient refresh failure cannot mask a concurrent permission invalidation or restore the old snapshot', async () => {
	const host = hostHarness()
	await host.controller.refresh()
	const transient = Promise.withResolvers<NativeGnosisSafeAppsResponse>()
	host.setPreparation(async () => await transient.promise)
	const refreshing = host.controller.refresh()
	host.setPreparation(async () => ({ id: 'prepare', success: false, error: 'Website permission revoked' }))
	host.controller.invalidateContext(['websiteAccess'])
	transient.reject(new Error('Old transport failure'))
	await refreshing
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	assert.equal(host.controller.view.value.status, 'Website permission revoked')
	const denied = host.controller.receive(request('revoked-info', 'getSafeInfo'))
	assert.ok(host.pending.has('revoked-info'), 'explicit invalidation removes the stale cached metadata')
	host.pending.get('revoked-info')?.resolve({ id: 'revoked-info', success: false, error: 'Website permission revoked' })
	await denied
	assert.equal(host.replies.at(-1)?.success, false)
})

test('refresh errors after a context change preserve admitted mutation replies while blocking new requests', async () => {
	const host = hostHarness()
	await host.controller.refresh()
	const frame = host.controller.view.value
	const operation = host.controller.receive(request('operation', 'sendTransactions'))
	host.setPreparation(async () => { throw new Error('Current wallet unavailable') })
	host.controller.invalidateContext(['simulationMode'])
	await host.controller.refresh()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration)
	assert.match(host.controller.view.value.status, /Wallet or permissions changed/)
	assert.match(host.controller.view.value.status, /Current wallet unavailable/)
	assert.equal(host.controller.retryDisabled.value, true)
	await host.controller.receive(request('new-info', 'getSafeInfo'))
	assert.equal(host.replies.at(-1)?.success, false)
	assert.equal(host.requests.some(({ id }) => id === 'new-info'), false)
	host.pending.get('operation')?.resolve({ id: 'operation', success: true, data: { safeTxHash: 'terminal-result' } })
	await operation
	assert.deepEqual(host.replies.at(-1), { id: 'operation', success: true, data: { safeTxHash: 'terminal-result' } })
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration)
	assert.equal(host.controller.retryDisabled.value, false)
	assert.equal(host.controller.retry(), true)
})

test('extension disconnection clears prepared metadata, preserves an idle app and cannot recover from a stale refresh', async () => {
	const host = hostHarness()
	host.controller.start()
	await host.controller.refresh()
	const stale = Promise.withResolvers<NativeGnosisSafeAppsResponse>()
	host.setPreparation(async () => await stale.promise)
	const refreshing = host.controller.refresh()
	host.controller.disconnectExtension()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	assert.equal(host.controller.view.value.lastContextChange, 'extensionConnection')
	assert.match(host.controller.view.value.status, /extension connection was lost/)
	assert.equal(host.timers.size, 0)
	stale.resolve(metadata('stale-wallet'))
	await refreshing
	host.advance(30_000)
	await host.controller.refresh()
	host.controller.invalidateContext(['simulationMode'])
	await host.controller.receive(request('disconnected-info', 'getSafeInfo'))
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.match(host.controller.view.value.status, /extension connection was lost/)
	assert.equal(host.requests.length, 2, 'a disconnected extension cannot restart metadata polling')
	assert.equal(host.replies.at(-1)?.success, false, 'the previous prepared response is no longer available and disconnected requests are refused')
})

for (const success of [true, false]) test(`extension disconnection preserves an admitted mutation's ${ success ? 'successful' : 'rejected' } terminal reply and blocks further admission`, async () => {
	const host = hostHarness()
	await host.controller.refresh()
	const frame = host.controller.view.value
	const operation = host.controller.receive(request('operation', 'sendTransactions'))
	host.controller.disconnectExtension()
	assert.equal(host.controller.view.value.frameHidden, false)
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration)
	assert.equal(host.controller.retry(), false)
	await host.controller.receive(request('disconnected-info', 'getSafeInfo'))
	assert.equal(host.replies.at(-1)?.success, false)
	assert.equal(host.requests.some(({ id }) => id === 'disconnected-info'), false, 'disconnection clears cached discovery and refuses new background requests')
	const terminal = { id: 'operation', success, ...(success ? { data: { safeTxHash: 'terminal-result' } } : { error: 'Extension disconnected' }) }
	host.pending.get('operation')?.resolve(terminal)
	await operation
	assert.deepEqual(host.replies.at(-1), terminal)
	assert.equal(host.controller.view.value.frameGeneration, frame.frameGeneration)
	assert.match(host.controller.view.value.status, /Pending requests finished.*extension connection was lost/)
	assert.equal(host.controller.retryDisabled.value, false)
})


test('unsupported embedding exposes an actionable connection error without changing frame restrictions', () => {
	const host = hostHarness()
	host.controller.start()
	host.advance(NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs + 1)
	assert.equal(host.controller.view.value.connectionError, true)
	assert.match(host.controller.view.value.status, /block embedded pages/)
	assert.match(host.controller.view.value.status, /Retry the connection or open the website directly/)
	assert.equal(host.controller.view.value.frameUrl, 'https://app.example/swap')
	host.controller.stop()
})
