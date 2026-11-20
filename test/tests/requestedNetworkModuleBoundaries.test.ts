import * as assert from 'assert'
import { test } from 'bun:test'
import * as path from 'path'
import { getRuntimeDependencies, getRuntimeModulesReachableFrom } from './runtimeDependencyGraph.js'

const backgroundDirectory = path.join(import.meta.dir, '..', '..', 'app', 'ts', 'background')
const backgroundModule = (name: string) => path.join(backgroundDirectory, name)
const transportModules = [backgroundModule('messageSending.ts'), backgroundModule('manifestV2Reconnect.ts')]
const networkRuleModule = backgroundModule('transactionNetwork.ts')
const forwardingModule = backgroundModule('requestedNetworkForwarding.ts')
const networkPolicyModules = [networkRuleModule, forwardingModule]
// activeNetworkStorage.ts owns the counted active-network writer and its freshness counters, and storageUtils.ts the generic storage setters, so both count as storage here.
const storageModules = [backgroundModule('settings.ts'), backgroundModule('storageVariables.ts'), backgroundModule('activeNetworkStorage.ts'), path.join(import.meta.dir, '..', '..', 'app', 'ts', 'utils', 'storageUtils.ts')]

const listReached = (from: readonly string[], forbidden: readonly string[]) => from.flatMap((module) => [...getRuntimeModulesReachableFrom([module])]
	.filter((reached) => forbidden.includes(reached))
	.map((reached) => `${ path.basename(module) } reaches ${ path.basename(reached) }`))

// A refusal is derived when the queue is sent, so the settings transition only tells the windows of a network change, and the confirmation window, which asks for its queue again on that message, stays out of it. The network rule stays out of the cycle the settings transition is part of.
test('the settings transition depends on neither the network rule nor the confirmation window', () => {
	const settingsTransitionModule = backgroundModule('activeSettings.ts')
	const directImports = getRuntimeDependencies(settingsTransitionModule).map((dependency) => dependency.module)
	assert.equal(directImports.includes(networkRuleModule), false)
	assert.equal(directImports.includes(path.join(backgroundDirectory, 'windows', 'confirmTransaction.ts')), false)
	assert.deepEqual(listReached([networkRuleModule], [settingsTransitionModule]), [])
})

// The rule for which confirmation run is current only reads the runs it is given, so the modules that store a visualisation share it without depending on the simulation code.
test('the confirmation run rule is a leaf that the Gnosis Safe signer refresh uses without the simulation code', () => {
	assert.deepEqual(getRuntimeDependencies(backgroundModule('confirmationRun.ts')).map((dependency) => path.relative(backgroundDirectory, dependency.module)), [path.join('..', 'utils', 'bigint.ts')])
	assert.deepEqual(listReached([backgroundModule('safeSignerSelectionRefresh.ts')], [backgroundModule('confirmTransactionSimulation.ts')]), [])
})

// The run tracker keeps only per-request run state, so it depends on no storage, simulation or window code and can be tested on its own.
test('the confirmation run tracker depends on no storage, simulation or window code', () => {
	assert.deepEqual(getRuntimeDependencies(backgroundModule('confirmationRunTracker.ts')).map((dependency) => path.relative(backgroundDirectory, dependency.module)).toSorted(), [path.join('..', 'utils', 'constants.ts'), path.join('..', 'utils', 'requests.ts')])
})

// A rejection must never wait for simulation or window work, so the module that commits it reaches none of that code.
test('the commits of a pending request reach no simulation or confirmation window code', () => {
	const simulationOrWindowModules = ['confirmTransactionSimulation.ts', 'simulationUpdating.ts', 'popupVisualisationUpdater.ts', path.join('windows', 'confirmTransaction.ts')].map(backgroundModule)
	assert.deepEqual(listReached([backgroundModule('pendingRequestLocks.ts')], simulationOrWindowModules), [])
})

// requestedNetworkForwarding.ts composes delivery with the requested-network rule, so neither side depends on the other.
test('the transport depends on no network policy or storage, and the network rule on no delivery', () => {
	// The transport already reaches settings and storage indirectly through backgroundUtils.ts, so for those only its own imports are checked.
	const directImportsOfPolicyOrStorage = transportModules.flatMap((module) => getRuntimeDependencies(module)
		.filter((dependency) => [...networkPolicyModules, ...storageModules].includes(dependency.module))
		.map((dependency) => `${ path.basename(module) } imports ${ path.basename(dependency.module) }`))
	assert.deepEqual(directImportsOfPolicyOrStorage, [])
	assert.deepEqual(listReached(transportModules, networkPolicyModules), [])
	assert.deepEqual(listReached([networkRuleModule], [...transportModules, forwardingModule]), [])
	const forwardingImports = getRuntimeDependencies(forwardingModule).map((dependency) => dependency.module)
	for (const composed of [networkRuleModule, backgroundModule('messageSending.ts'), backgroundModule('manifestV2Reconnect.ts')]) assert.ok(forwardingImports.includes(composed), composed)
})

// The confirmation window's publication reads the stored queue and derives its refusals on its own, so the confirmation resolution and the popup handlers share it without depending on each other for it, and it depends on neither.
test('the confirmation window publication depends on neither the confirmation resolution nor the popup handlers', () => {
	const publicationModule = backgroundModule('confirmationWindowPublication.ts')
	const confirmationModule = path.join(backgroundDirectory, 'windows', 'confirmTransaction.ts')
	const popupHandlersModule = backgroundModule('popupMessageHandlers.ts')
	assert.deepEqual(listReached([publicationModule], [confirmationModule, popupHandlersModule]), [])
	const publicationExports = ['publishConfirmationView', 'publishConfirmationQueue', 'readConfirmationQueue', 'updateConfirmTransactionView', 'updateConfirmationSimulationView', 'reportFailedWindowUpdate']
	for (const consumer of [confirmationModule, popupHandlersModule, backgroundModule('popupMessageDispatcher.ts'), backgroundModule('providerMessageHandlers.ts')]) {
		const dependencies = getRuntimeDependencies(consumer)
		const publicationNamesFromOtherModules = dependencies.filter((dependency) => dependency.module !== publicationModule).flatMap((dependency) => dependency.names === 'whole module' ? [] : dependency.names.filter((name) => publicationExports.includes(name)))
		assert.deepEqual(publicationNamesFromOtherModules, [], path.basename(consumer))
	}
})

// The freshness protocol of the active network has one owner: the counters and their compare are private to activeNetworkStorage.ts, and every reader that acts on the stored network does so through its bounded actOnStoredActiveNetwork.
test('only activeNetworkStorage.ts reads and compares the active network write counters', async () => {
	const activeNetworkStorage = await import('../../app/ts/background/activeNetworkStorage.js')
	for (const privateName of ['beginActiveNetworkRead', 'observeActiveNetworkChanges']) assert.equal(privateName in activeNetworkStorage, false, privateName)
	const activeNetworkStorageModule = backgroundModule('activeNetworkStorage.ts')
	const appDirectory = path.join(import.meta.dir, '..', '..', 'app', 'ts')
	const snapshotReaders: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appDirectory, absolute: true })) {
		if (file === activeNetworkStorageModule) continue
		const names = getRuntimeDependencies(file).filter((dependency) => dependency.module === activeNetworkStorageModule).flatMap((dependency) => dependency.names === 'whole module' ? ['whole module'] : dependency.names)
		if (names.includes('readActiveNetworkSnapshot') || names.includes('whole module')) snapshotReaders.push(path.relative(appDirectory, file))
	}
	assert.deepEqual(snapshotReaders, [])
	assert.deepEqual(getRuntimeDependencies(networkRuleModule).filter((dependency) => dependency.module === activeNetworkStorageModule).map((dependency) => dependency.names), [['actOnStoredActiveNetwork']])
	assert.doesNotMatch(await Bun.file(networkRuleModule).text(), /while \(true\)/u)
})
