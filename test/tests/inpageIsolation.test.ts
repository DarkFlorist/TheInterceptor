import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inpageIsolation } from '../../build/inpageIsolation.mts'

async function buildFixture(entry: string, shared: string, approveShared: boolean) {
	const directory = await mkdtemp(join(tmpdir(), 'inpage-isolation-'))
	try {
		const main = join(directory, 'main.ts')
		const helper = join(directory, 'helper.ts')
		await Bun.write(main, entry)
		await Bun.write(helper, shared)
		await Bun.write(join(directory, 'background.ts'), 'export const secret = 1')
		return await Bun.build({ throw: false, entrypoints: [main], target: 'browser', format: 'iife', plugins: [inpageIsolation(approveShared ? [main, helper] : [main])] })
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

test('inpage build permits an explicitly approved static helper', async () => {
	const result = await buildFixture('import { value } from \'./helper.js\'; console.log(value)', 'export const value = 1', true)
	expect(result.success).toBe(true)
})

test('inpage build rejects direct and transitive unapproved imports', async () => {
	const entry = 'import { value } from \'./helper.js\'; console.log(value)'
	const direct = await buildFixture(entry, 'export const value = 1', false)
	expect(direct.success).toBe(false)
	expect(direct.logs.join()).toContain('Unapproved inpage dependency')
	const transitive = await buildFixture(entry, 'export { secret as value } from \'./background.js\'', true)
	expect(transitive.success).toBe(false)
	expect(transitive.logs.join()).toContain('Unapproved inpage dependency')
})

test('inpage build rejects runtime loading, including computed module paths', async () => {
	for (const entry of ['import(\'./helper.js\')', 'const name = location.hash; import(name)', 'require(\'./helper.js\')']) {
		const result = await buildFixture(entry, 'export const value = 1', true)
		expect(result.success).toBe(false)
		expect(result.logs.join()).toContain('Runtime module loading is forbidden')
	}
})

test('inpage build rejects dependencies introduced into an approved helper', async () => {
	const result = await buildFixture('import { value } from \'./helper.js\'; console.log(value)', 'import { secret } from \'./nested/../background.js\'; export const value = secret', true)
	expect(result.success).toBe(false)
	expect(result.logs.join()).toContain('Unapproved inpage dependency')
})
