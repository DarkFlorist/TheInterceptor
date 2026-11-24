import { runSimulationSettingsTransition } from '../../app/ts/background/simulationSettingsTransition.js'
import { Future } from '../../app/ts/utils/future.js'
import * as assert from 'assert'
import { DEFAULT_RPCS } from '../../app/ts/config/defaults.js'
import { createEthereumWithGetBlockCounter, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { test } from 'bun:test'
import { createEthereumClientService, createSimulationServicesOwner, createSimulationServicesOwnerForServices, type SimulationNetworkReconciliation, type SimulationServicesOwner, type SimulationServicesUpdate } from '../../app/ts/simulation/serviceLifecycle.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { alwaysLive } from '../../app/ts/simulation/services/clientLiveness.js'

const ignoreRefresh = async () => undefined
const rethrow = async (error: unknown) => { throw error }
// Reconciles one network in its own scoped update, the way a settings transition does.
const ensureNetworkOf = async (owner: SimulationServicesOwner, network: RpcNetwork, options?: { readonly updateMetadata?: boolean }): Promise<SimulationNetworkReconciliation> => await owner.update(async ({ ensureNetwork }) => ensureNetwork(network, options))

test('the service owner publishes each installed pair and retains captured snapshots', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const original = owner.getCurrent()
	try {
		for (const chainId of [2n, 3n]) {
			const network = { ...rpc, chainId, httpsRpc: `https://chain${ chainId }.invalid` }
			await owner.update(async ({ ensureNetwork }) => ensureNetwork(network))
			const replacement = owner.getCurrent()
			assert.notEqual(replacement.ethereum, original.ethereum)
			assert.deepEqual(replacement.ethereum.getRpcEntry(), network)
		}
		// A captured pair remains a snapshot; it cannot mutate the owner's current selection.
		assert.deepEqual(original.ethereum.getRpcEntry(), rpc)
		assert.notEqual(owner.getCurrent(), original)
	} finally { owner.getCurrent().ethereum.cleanup() }
})


test('network reconciliation permanently retires the replaced client', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async () => undefined, ignoreRefresh, rethrow)
	const replaced = owner.getCurrent()
	try {
		assert.equal(await ensureNetworkOf(owner, { ...rpc, chainId: 10n, httpsRpc: 'https://replacement.invalid' }), 'replaced')
		replaced.ethereum.setBlockPolling(true)
		assert.equal(replaced.ethereum.isBlockPolling(), false)
	} finally {
		replaced.ethereum.cleanup()
		owner.getCurrent().ethereum.cleanup()
	}
})

test('a captured client can execute RPC work after the owner installs its replacement', async () => {
	const paths: string[] = []
	const server = Bun.serve({
		hostname: '127.0.0.1', port: 0,
		async fetch(request) {
			const message: unknown = await request.json()
			if (typeof message !== 'object' || message === null || !('id' in message)) throw new Error('Missing fixture request ID')
			paths.push(new URL(request.url).pathname)
			return Response.json({ jsonrpc: '2.0', id: message.id, result: '0x01' })
		},
	})
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: `${ server.url }initial`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const snapshot = owner.getCurrent()
	try {
		await owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: `${ server.url }replacement` }))
		assert.deepEqual(await snapshot.ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(await owner.getCurrent().ethereum.getCode(1n, 'latest', undefined), new Uint8Array([1]))
		assert.deepEqual(paths, ['/initial', '/replacement'])
	} finally {
		owner.getCurrent().ethereum.cleanup()
		server.stop(true)
	}
})

test('the owner answers whether a pair it handed out is still installed', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const original = owner.getCurrent()
	// A temporary client that no owner installed has nothing replacing it.
	const temporary = createEthereumClientService(rpc, async () => undefined, async (_ethereum, error) => { throw error }, alwaysLive)
	try {
		assert.equal(original.ethereum.isCurrent(), true)
		// Installing a replacement retires every pair handed out before it, so work holding the old one steps aside.
		await owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://replacement.invalid' }))
		const replacement = owner.getCurrent()
		assert.equal(original.ethereum.isCurrent(), false)
		assert.equal(replacement.ethereum.isCurrent(), true)
		await owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://latest.invalid' }))
		const latest = owner.getCurrent()
		assert.equal(replacement.ethereum.isCurrent(), false)
		assert.equal(latest.ethereum.isCurrent(), true)
		assert.equal(temporary.isCurrent(), true)
	} finally {
		owner.getCurrent().ethereum.cleanup()
		temporary.cleanup()
	}
})

test('every scoped replacement refreshes once after the complete update even when its caller requests no refresh', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const order: string[] = []
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async (services, outcome) => {
		assert.equal(services, owner.getCurrent())
		assert.deepEqual(outcome, { status: 'completed', replacement: 'replaced' })
		order.push('refresh')
	}, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	try {
		await owner.update(async ({ ensureNetwork }) => {
			ensureNetwork({ ...rpc, httpsRpc: 'https://first.invalid' })
			ensureNetwork({ ...rpc, httpsRpc: 'https://replacement.invalid' })
			await Promise.resolve()
			order.push('settings, stack and notifications complete')
		})
		assert.deepEqual(order, ['settings, stack and notifications complete', 'refresh'])
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})


test('an update context cannot replace services after its callback has completed', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	let refreshes = 0
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => { refreshes += 1 }, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	let captured: SimulationServicesUpdate | undefined
	try {
		await owner.update(async (update) => { captured = update })
		const expired = captured
		if (expired === undefined) throw new Error('Missing captured update')
		assert.throws(() => expired.ensureNetwork({ ...rpc, httpsRpc: 'https://expired.invalid' }), /no longer active/)
		assert.throws(() => expired.requestRefresh(), /no longer active/)
		assert.equal(refreshes, 0)
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})


test('a slow refresh observer does not block another replacement', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const started = new Future<void>()
	const release = new Future<void>()
	let observerCalls = 0
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => {
		observerCalls += 1
		if (observerCalls === 1) { started.resolve(undefined); await release }
	}, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const first = owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://first.invalid' }))
	try {
		await started
		assert.equal(await owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://next.invalid' })), 'replaced')
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, 'https://next.invalid')
		assert.equal(observerCalls, 2)
	} finally {
		release.resolve(undefined)
		await first
		owner.getCurrent().ethereum.cleanup()
	}
})


test('an unfinished update does not block replacement and observes its own retired pair', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const started = new Future<void>()
	const release = new Future<void>()
	const observed: string[] = []
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async (services) => { observed.push(services.ethereum.getRpcEntry().httpsRpc) }, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const first = owner.update(async ({ ensureNetwork }) => {
		ensureNetwork({ ...rpc, httpsRpc: 'https://first.invalid' })
		started.resolve(undefined)
		await release
	})
	await started
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://second.invalid' })),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Replacement waited for an unrelated update callback')), 1000) }),
		])
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, 'https://second.invalid')
	} finally {
		clearTimeout(timer)
		release.resolve(undefined)
		await first
		owner.getCurrent().ethereum.cleanup()
	}
	assert.deepEqual(observed, ['https://second.invalid', 'https://first.invalid'])
})


test('a settings transition releases its application lock before its refresh observer', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const order: string[] = []
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => {
		if (order.includes('observer')) return
		order.push('observer')
		await runSimulationSettingsTransition(owner, async ({ ensureNetwork }) => {
			order.push('next settings transition')
			ensureNetwork({ ...rpc, httpsRpc: 'https://next.invalid' })
		})
	}, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			runSimulationSettingsTransition(owner, async ({ ensureNetwork }) => { ensureNetwork({ ...rpc, httpsRpc: 'https://settings.invalid' }); order.push('settings complete') }),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Observer retained the settings transition lock')), 1000) }),
		])
		assert.deepEqual(order, ['settings complete', 'observer', 'next settings transition'])
	} finally {
		clearTimeout(timer)
		owner.getCurrent().ethereum.cleanup()
	}
})


test('settings transitions run one at a time under the transition lock', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const firstBroadcasting = new Future<void>()
	const releaseFirstBroadcast = new Future<void>()
	const order: string[] = []
	const first = runSimulationSettingsTransition(owner, async ({ ensureNetwork }) => {
		order.push('first starts')
		ensureNetwork({ ...rpc, httpsRpc: 'https://first.invalid' })
		firstBroadcasting.resolve(undefined)
		await releaseFirstBroadcast
		order.push('first ends')
	})
	try {
		await firstBroadcasting
		const second = runSimulationSettingsTransition(owner, async ({ ensureNetwork }) => {
			order.push('second starts')
			ensureNetwork({ ...rpc, httpsRpc: 'https://second.invalid' })
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		assert.deepEqual(order, ['first starts'])
		releaseFirstBroadcast.resolve(undefined)
		await Promise.all([first, second])
		assert.deepEqual(order, ['first starts', 'first ends', 'second starts'])
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, 'https://second.invalid')
	} finally {
		releaseFirstBroadcast.resolve(undefined)
		await first
		owner.getCurrent().ethereum.cleanup()
	}
})


test('a service replacement does not wait behind a settings transition stalled in message broadcast', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const observed: string[] = []
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async (services) => { observed.push(services.ethereum.getRpcEntry().httpsRpc) }, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	const broadcasting = new Future<void>()
	const releaseBroadcast = new Future<void>()
	const transition = runSimulationSettingsTransition(owner, async ({ ensureNetwork }) => {
		ensureNetwork({ ...rpc, httpsRpc: 'https://transition.invalid' })
		broadcasting.resolve(undefined)
		await releaseBroadcast
	})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await broadcasting
		const replacement = await Promise.race([
			owner.update(async ({ ensureNetwork }) => ensureNetwork({ ...rpc, httpsRpc: 'https://replacement.invalid' })),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Replacement waited for the settings transition lock')), 1000) }),
		])
		assert.equal(replacement, 'replaced')
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, 'https://replacement.invalid')
	} finally {
		clearTimeout(timer)
		releaseBroadcast.resolve(undefined)
		await transition
		owner.getCurrent().ethereum.cleanup()
	}
	// The stalled transition still observes its own pair, which the newer replacement has retired.
	assert.deepEqual(observed, ['https://replacement.invalid', 'https://transition.invalid'])
})

for (const replaceServices of [false, true]) test(`a failed update retains its actual replacement outcome (replacement requested: ${ replaceServices })`, async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const failure = new Error('Notification failed after requesting refresh')
	let observations = 0
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async (_services, outcome) => {
		observations += 1
		assert.deepEqual(outcome, { status: 'failed', error: failure, replacement: replaceServices ? 'replaced' : 'unchanged' })
	}, async (error) => { await (await import('../../app/ts/utils/errors.js')).reportUnexpectedError(error, { code: 'simulation_services_refresh_failed' }) })
	try {
		await assert.rejects(owner.update(async ({ ensureNetwork, requestRefresh }) => {
			if (replaceServices) ensureNetwork({ ...rpc, httpsRpc: 'https://replacement.invalid' })
			else requestRefresh()
			throw failure
		}), (error) => error === failure)
		assert.equal(observations, 1)
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})

for (const applyFails of [false, true]) for (const reportingFails of [false, true]) test(`observer errors stay separate from the committed result (apply fails: ${ applyFails }, reporter fails: ${ reportingFails })`, async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const applyError = new Error('Transition notification failed')
	const observerError = new Error('Refresh observer failed')
	const reportingError = new Error('Diagnostic storage failed')
	const reported: unknown[] = []
	const owner = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => { throw observerError }, async (error) => {
		reported.push(error)
		if (reportingFails) throw reportingError
	})
	try {
		const update = owner.update(async ({ ensureNetwork }) => {
			ensureNetwork({ ...rpc, httpsRpc: 'https://committed.invalid' })
			if (applyFails) throw applyError
			return 42
		})
		if (reportingFails) {
			await assert.rejects(update, (error) => {
				assert.ok(error instanceof AggregateError)
				assert.deepEqual(error.errors, applyFails ? [applyError, observerError, reportingError] : [observerError, reportingError])
				return true
			})
		} else if (applyFails) await assert.rejects(update, (error) => error === applyError)
		else assert.equal(await update, 42)
		assert.deepEqual(reported, [observerError])
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, 'https://committed.invalid')
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})


for (const catchResetError of [false, true]) test(`replacement failure is distinct from a later callback failure (caller catches reset: ${ catchResetError })`, async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const failure = new Error('Replacement construction failed')
	const original = createSimulationServicesOwner(rpc, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { throw error })
	let observations = 0
	const owner = createSimulationServicesOwnerForServices(rpc, original.getCurrent(), () => { throw failure }, async (services, outcome) => {
		observations += 1
		assert.equal(services, original.getCurrent())
		assert.deepEqual(outcome, catchResetError ? { status: 'completed', replacement: 'failed' } : { status: 'failed', replacement: 'failed', error: failure })
	}, async (error) => { throw error })
	try {
		const update = owner.update(async ({ ensureNetwork }) => {
			try { ensureNetwork({ ...rpc, httpsRpc: 'https://failed.invalid' }) } catch (error) { if (!catchResetError) throw error }
			return 42
		})
		if (catchResetError) assert.equal(await update, 42)
		else await assert.rejects(update, (error) => error === failure)
		assert.equal(observations, 1)
	} finally {
		original.getCurrent().ethereum.cleanup()
	}
})

test('a refresh request after a caught reset failure stays bound to the pair that failed', async () => {
	const rpc = { name: 'Initial', chainId: 1n, httpsRpc: 'https://initial.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const makeOwner = (httpsRpc: string) => createSimulationServicesOwner({ ...rpc, httpsRpc }, async () => undefined, async (_ethereum, error) => { throw error }, async () => undefined, async (error) => { throw error })
	const initialOwner = makeOwner(rpc.httpsRpc)
	const replacementOwner = makeOwner('https://replacement.invalid')
	const initialPair = initialOwner.getCurrent()
	const replacementPair = replacementOwner.getCurrent()
	const failure = new Error('Reset construction failed')
	const failed = new Future<void>()
	const resume = new Future<void>()
	const observations: { services: typeof initialPair, replacement: string }[] = []
	const owner = createSimulationServicesOwnerForServices(rpc, initialPair, (_current, network) => {
		if (network.httpsRpc === 'https://failed.invalid') throw failure
		return replacementPair
	}, async (services, outcome) => { observations.push({ services, replacement: outcome.replacement }) }, async (error) => { throw error })
	const first = owner.update(async ({ ensureNetwork, requestRefresh }) => {
		assert.throws(() => ensureNetwork({ ...rpc, httpsRpc: 'https://failed.invalid' }), (error) => error === failure)
		failed.resolve(undefined)
		await resume
		requestRefresh()
	})
	try {
		await failed
		await owner.update(async ({ ensureNetwork }) => { ensureNetwork({ ...rpc, httpsRpc: 'https://replacement.invalid' }) })
		resume.resolve(undefined)
		await first
		assert.deepEqual(observations, [{ services: replacementPair, replacement: 'replaced' }, { services: initialPair, replacement: 'failed' }])
		assert.equal(owner.getCurrent(), replacementPair)
	} finally {
		resume.resolve(undefined)
		await first
		initialPair.ethereum.cleanup()
		replacementPair.ethereum.cleanup()
	}
})

test('reconciles selected networks against the installed client', async () => {
	const initialNetwork = DEFAULT_RPCS[0]
	if (initialNetwork === undefined) throw new Error('Expected a default RPC endpoint')
	const owner = createSimulationServicesOwner(initialNetwork, async () => undefined, async (_ethereum, error) => { throw error }, ignoreRefresh, rethrow)
	try {
		const initialServices = owner.getCurrent()
		assert.equal(await ensureNetworkOf(owner, { ...initialNetwork, name: 'Renamed endpoint' }), 'unchanged')
		assert.equal(owner.getCurrent(), initialServices)
		const renamed = { ...initialNetwork, name: 'Fresh metadata' }
		assert.equal(await ensureNetworkOf(owner, renamed, { updateMetadata: true }), 'replaced')
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().name, renamed.name)
		assert.equal(initialServices.ethereum.getRpcEntry().name, initialNetwork.name, 'Metadata replacement preserves existing snapshots')
		assert.equal(await ensureNetworkOf(owner, renamed, { updateMetadata: true }), 'unchanged')
		const nextNetwork = { ...initialNetwork, httpsRpc: 'https://replacement.example' }
		assert.equal(await ensureNetworkOf(owner, nextNetwork), 'replaced')
		const replacementServices = owner.getCurrent()
		assert.notEqual(replacementServices, initialServices)
		assert.equal(replacementServices.ethereum.getRpcEntry().httpsRpc, nextNetwork.httpsRpc)
		assert.equal(await ensureNetworkOf(owner, { ...nextNetwork, httpsRpc: undefined }), 'signerOnly')
		assert.equal(await ensureNetworkOf(owner, nextNetwork), 'unchanged')
		assert.equal(owner.getCurrent(), replacementServices, 'Signer-only selections retain the installed fallback endpoint')
		await ensureNetworkOf(owner, initialNetwork)
		const resetServices = owner.getCurrent()
		await ensureNetworkOf(owner, initialNetwork)
		assert.equal(owner.getCurrent(), resetServices, 'Repeated selections preserve the installed services')
		await ensureNetworkOf(owner, { ...initialNetwork, chainId: initialNetwork.chainId + 1n })
		assert.notEqual(owner.getCurrent(), resetServices, 'A different chain needs new services even at the same URL')
	} finally {
		owner.getCurrent().ethereum.cleanup()
	}
})

test('the test owner tracks replacement selections without changing injected client metadata', async () => {
	const services = createEthereumWithGetBlockCounter({ count: 0 })
	const initialNetwork = services.ethereum.getRpcEntry()
	let replacements = 0
	const owner = createTestSimulationServicesOwner(services, () => { replacements++; return services }, ignoreRefresh)
	assert.equal(await ensureNetworkOf(owner, initialNetwork), 'unchanged')
	assert.equal(await ensureNetworkOf(owner, { ...initialNetwork, name: 'Renamed' }), 'unchanged')
	assert.equal(replacements, 0)
	const next = { ...initialNetwork, httpsRpc: 'https://replacement.example' }
	assert.equal(await ensureNetworkOf(owner, next), 'replaced')
	assert.equal(owner.getCurrent(), services)
	assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, initialNetwork.httpsRpc)
	assert.equal(await ensureNetworkOf(owner, next), 'unchanged')
	assert.equal(replacements, 1)
})


test('injected owner selection is explicit and advances only after replacement succeeds', async () => {
	const services = createEthereumWithGetBlockCounter({ count: 0 })
	const actual = services.ethereum.getRpcEntry()
	const installed = { ...actual, httpsRpc: 'https://explicit-initial.example' }
	const next = { ...installed, httpsRpc: 'https://explicit-next.example' }
	let shouldFail = true
	let replacements = 0
	const owner = createSimulationServicesOwnerForServices(installed, services, (current) => {
		replacements++
		if (shouldFail) throw new Error('Replacement failed')
		return current
	}, ignoreRefresh, rethrow)
	assert.equal(await ensureNetworkOf(owner, installed), 'unchanged')
	await assert.rejects(ensureNetworkOf(owner, next), /Replacement failed/)
	assert.equal(await ensureNetworkOf(owner, installed), 'unchanged')
	shouldFail = false
	assert.equal(await ensureNetworkOf(owner, next), 'replaced')
	assert.equal(await ensureNetworkOf(owner, next), 'unchanged')
	assert.equal(replacements, 2)
	assert.equal(owner.getCurrent(), services)
	assert.deepEqual(services.ethereum.getRpcEntry(), actual)
})
