import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import ts from 'typescript'
import { test } from 'bun:test'
import { assertInpageImportBoundaries } from '../../scripts/check-inpage-import-boundaries.mts'

function fixture(files: Readonly<Record<string, string>>, run: (root: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-inpage-boundary-'))
	try {
		for (const directory of ['app/inpage/ts', 'app/shared/ts']) fs.mkdirSync(path.join(root, directory), { recursive: true })
		for (const [file, source] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
			fs.writeFileSync(path.join(root, file), source)
		}
		run(root)
	} finally { fs.rmSync(root, { recursive: true, force: true }) }
}

const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
const check = (root: string, extra: ts.CompilerOptions = {}) => assertInpageImportBoundaries(path.join(root, 'app/inpage/ts'), path.join(root, 'app/shared/ts'), { ...options, ...extra })

test('the actual page source and complete shared graph preserve their dependency boundary', () => check(process.cwd()))

test('inpage siblings and transitive shared protocol helpers are allowed', () => {
	fixture({
		'app/inpage/ts/main.ts': 'import \'./sibling.js\'\nimport \'../../shared/ts/protocol.js\'',
		'app/inpage/ts/sibling.ts': 'export const ready = true',
		'app/shared/ts/protocol.ts': 'export { value } from \'./leaf.js\'',
		'app/shared/ts/leaf.ts': 'export const value = 1',
	}, (root) => assert.doesNotThrow(() => check(root)))
})

for (const statement of ['import \'../../ts/background.js\'', 'export * from \'../../ts/background.js\'', 'void import(\'../../ts/background.js\')', 'require(\'../../ts/background.js\')', 'type Hidden = import(\'../../ts/background.js\').Value']) test(`extension imports remain forbidden before bundling: ${ statement }`, () => {
	fixture({ 'app/inpage/ts/main.ts': statement, 'app/ts/background.ts': 'export type Value = string' }, (root) => assert.throws(() => check(root), /outside the isolated/))
})

test('shared helpers cannot smuggle extension dependencies transitively', () => {
	fixture({ 'app/inpage/ts/main.ts': 'import \'../../shared/ts/protocol.js\'', 'app/shared/ts/protocol.ts': 'export * from \'../../ts/background.js\'', 'app/ts/background.ts': 'export const secret = 1' }, (root) => assert.throws(() => check(root), /outside the isolated/))
})

test('TypeScript aliases cannot bypass the resolved-file boundary', () => {
	fixture({ 'app/inpage/ts/main.ts': 'import \'@extension/background\'', 'app/ts/background.ts': 'export const value = 1' }, (root) => assert.throws(() => check(root, { baseUrl: root, paths: { '@extension/*': ['app/ts/*'] } }), /outside the isolated/))
})

test('computed imports are rejected instead of silently escaping the dependency graph', () => {
	fixture({ 'app/inpage/ts/main.ts': 'const target = location.hash; void import(target)' }, (root) => assert.throws(() => check(root), /computed module loading/))
})
