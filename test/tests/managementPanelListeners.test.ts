import * as assert from 'assert'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { test } from 'bun:test'

const sourceRoot = path.resolve(import.meta.dir, '../../app/ts')
const managementShell = path.join(sourceRoot, 'components/pages/ManagementView.tsx')
const directListenerRegistration = /browser\.runtime\.onMessage\.addListener|noReplyExpectingBrowserRuntimeOnMessageListener\(|subscribeToSimulationStatePublications\(/u

function resolveRelativeImport(importingFile: string, specifier: string) {
	const withoutExtension = path.resolve(path.dirname(importingFile), specifier).replace(/\.js$/u, '')
	return ['.ts', '.tsx'].map((extension) => `${ withoutExtension }${ extension }`).find((candidate) => existsSync(candidate))
}

function collectRuntimeImports(entry: string) {
	const visited = new Set<string>()
	const pending = [entry]
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || visited.has(file)) continue
		visited.add(file)
		for (const match of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\s)[^'\n]*?from\s+'(\.[^']+)'/gmu)) {
			const specifier = match[1]
			const resolved = specifier === undefined ? undefined : resolveRelativeImport(file, specifier)
			if (resolved !== undefined) pending.push(resolved)
		}
	}
	return visited
}

test('management panel components subscribe to runtime messages only through mount-scoped hooks', () => {
	const panelComponents = [...collectRuntimeImports(managementShell)].filter((file) => file.endsWith('.tsx'))
	assert.ok(panelComponents.some((file) => file.endsWith('AddressBook.tsx')), 'import graph did not reach the embedded panels')

	const directRegistrations = panelComponents.filter((file) => directListenerRegistration.test(readFileSync(file, 'utf8'))).map((file) => path.relative(sourceRoot, file))

	assert.deepEqual(directRegistrations, [], 'Use useRuntimeMessageListener (or another hook in components/hooks that removes its listener on unmount) instead of registering browser.runtime.onMessage listeners in a component.')
})
