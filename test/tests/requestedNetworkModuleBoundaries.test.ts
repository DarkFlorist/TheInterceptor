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

// A rejection must never wait for simulation or window work, so the module that commits it reaches none of that code.
test('the commits of a pending request reach no simulation or confirmation window code', () => {
	const simulationOrWindowModules = ['confirmTransactionSimulation.ts', 'simulationUpdating.ts', 'popupVisualisationUpdater.ts', path.join('windows', 'confirmTransaction.ts')].map(backgroundModule)
	assert.deepEqual(listReached([backgroundModule('pendingRequestCommits.ts')], simulationOrWindowModules), [])
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
