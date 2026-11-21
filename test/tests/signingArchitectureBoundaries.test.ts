import * as assert from 'node:assert'
import { test } from 'bun:test'
import { dirname, relative, resolve } from 'node:path'

const sourceRoot = new URL('../../app/ts/', import.meta.url).pathname
const signingDirectory = resolve(sourceRoot, 'signing')
const backgroundDirectory = resolve(sourceRoot, 'background')

// Static and dynamic module specifiers, including type-only imports and re-exports.
const moduleSpecifiers = (source: string) => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)'([^']+)'/gu)].map((match) => match[1] ?? '')

test('signing modules do not import background modules', async () => {
	const violations: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: signingDirectory, absolute: true })) {
		for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
			if (!specifier.startsWith('.')) continue
			const target = resolve(dirname(file), specifier)
			if (target === backgroundDirectory || target.startsWith(`${ backgroundDirectory }/`)) violations.push(`${ relative(sourceRoot, file) } imports ${ specifier }`)
		}
	}
	assert.deepEqual(violations, [], 'signing/ is used by the background and by extension pages, so the background owns the stores signing state lives in')
})

test('only the signing coordinator and the Safe details writer write the address book', async () => {
	const writers: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceRoot, absolute: true })) {
		if (/\buserAddressBookEntriesStorageWrite\(/u.test(await Bun.file(file).text())) writers.push(relative(sourceRoot, file))
	}
	// Address-book edits can change which addresses may keep a signing wallet; addressBookStore only exports the definition, the narrowly typed Safe details writer and legacy repair.
	assert.deepEqual(writers.sort(), ['background/addressBookStore.ts', 'background/signingAddressBookCoordinator.ts'])
})

// Relative value imports and re-exports of one module, as source paths; type-only imports do not load modules.
async function getValueImports(file: string) {
	const source = await Bun.file(file).text()
	const specifiers = [...source.matchAll(/^(?:import|export)\s+(?!type\b)[^'\n]*?from\s*'(\.[^']+)'|^import\s+'(\.[^']+)'/gmu)].map((match) => match[1] ?? match[2] ?? '')
	return specifiers.map((specifier) => resolve(dirname(file), specifier).replace(/\.js$/u, '.ts'))
}

async function getImportGraph() {
	const graph = new Map<string, readonly string[]>()
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceRoot, absolute: true })) graph.set(file, await getValueImports(file))
	return graph
}

function isInImportCycle(graph: ReadonlyMap<string, readonly string[]>, module: string) {
	const seen = new Set<string>()
	const pending = [...graph.get(module) ?? []]
	while (pending.length > 0) {
		const next = pending.pop()
		if (next === undefined || seen.has(next)) continue
		if (next === module) return true
		seen.add(next)
		pending.push(...graph.get(next) ?? [])
	}
	return false
}

test('the signing wallet and address-book storage modules are in no import cycle', async () => {
	const graph = await getImportGraph()
	const modules = ['background/signingAddressBookCoordinator.ts', 'background/signingWalletStore.ts', 'background/addressBookStore.ts', 'background/settings.ts']
	assert.deepEqual(modules.filter((module) => isInImportCycle(graph, resolve(sourceRoot, module))), [])
})

test('address metadata does not depend on signing wallet storage or popup broadcasts', async () => {
	const imports = (await getValueImports(resolve(sourceRoot, 'background/metadataUtils.ts'))).map((file) => relative(sourceRoot, file))
	// metadataUtils is used throughout the background; it caches identified addresses with addressBookStore's eligibility-neutral addition instead.
	assert.deepEqual(imports.filter((file) => ['background/signingAddressBookCoordinator.ts', 'background/signingWalletStore.ts', 'background/backgroundUtils.ts'].includes(file)), [])
})

test('direct signing reaches the reviewed network through the Ethereum client factory, not a raw request handler', async () => {
	const imports = (await getValueImports(resolve(sourceRoot, 'background/directSigning.ts'))).map((file) => relative(sourceRoot, file))
	assert.equal(imports.includes('simulation/services/EthereumJSONRpcRequestHandler.ts'), false)
	assert.equal(imports.includes('simulation/serviceLifecycle.ts'), true)
})

// utils/ is below the Safe domain: safe/ imports utils/, so a utils module must not import safe/ back. Shared pure Safe rules, such as the signing plan, live in utils/.
test('utility modules do not import the Safe domain', async () => {
	const utilsDirectory = resolve(sourceRoot, 'utils')
	const safeDirectory = resolve(sourceRoot, 'safe')
	const violations: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: utilsDirectory, absolute: true })) {
		for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
			if (!specifier.startsWith('.')) continue
			const target = resolve(dirname(file), specifier)
			if (target.startsWith(`${ safeDirectory }/`)) violations.push(`${ relative(sourceRoot, file) } imports ${ specifier }`)
		}
	}
	assert.deepEqual(violations, [])
})
