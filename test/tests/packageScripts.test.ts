import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'

const repositoryRoot = process.cwd()

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPackageScripts() {
	const packageJsonPath = path.join(repositoryRoot, 'package.json')
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
	if (!isRecord(packageJson)) throw new Error('package.json root must be an object')
	const scripts = packageJson.scripts
	if (!isRecord(scripts)) throw new Error('package.json scripts must be an object')
	return scripts
}

function getScript(scripts: Record<string, unknown>, scriptName: string) {
	const script = scripts[scriptName]
	if (typeof script !== 'string') throw new Error(`Missing package script: ${ scriptName }`)
	return script
}

describe('package scripts', () => {
	test('firefox build compiles app scripts before writing the manifest', () => {
		const scripts = getPackageScripts()

		assert.deepEqual(getScript(scripts, 'build-firefox').split(' && '), [
			'bun run clean-js-output',
			'bun --bun tsc --project tsconfig.json',
			'bun run bundle',
			'bun run firefox',
		])
	})
})
