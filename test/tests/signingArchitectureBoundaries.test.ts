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
