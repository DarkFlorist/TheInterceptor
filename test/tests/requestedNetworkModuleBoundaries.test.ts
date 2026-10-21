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

const listReached = (from: readonly string[], forbidden: readonly string[]) => from.flatMap((module) => [...getRuntimeModulesReachableFrom([module])]
	.filter((reached) => forbidden.includes(reached))
	.map((reached) => `${ path.basename(module) } reaches ${ path.basename(reached) }`))

// requestedNetworkForwarding.ts composes delivery with the requested-network rule, so neither side depends on the other.
test('the transport depends on no network policy or storage, and the network rule on no delivery', () => {
	// The transport already reaches settings and storage indirectly through backgroundUtils.ts, so for those only its own imports are checked.
	const directImportsOfPolicyOrStorage = transportModules.flatMap((module) => getRuntimeDependencies(module)
		.filter((dependency) => [...networkPolicyModules, backgroundModule('settings.ts'), backgroundModule('storageVariables.ts')].includes(dependency.module))
		.map((dependency) => `${ path.basename(module) } imports ${ path.basename(dependency.module) }`))
	assert.deepEqual(directImportsOfPolicyOrStorage, [])
	assert.deepEqual(listReached(transportModules, networkPolicyModules), [])
	assert.deepEqual(listReached([networkRuleModule], [...transportModules, forwardingModule]), [])
	const forwardingImports = getRuntimeDependencies(forwardingModule).map((dependency) => dependency.module)
	for (const composed of [networkRuleModule, backgroundModule('messageSending.ts'), backgroundModule('manifestV2Reconnect.ts')]) assert.ok(forwardingImports.includes(composed), composed)
})
