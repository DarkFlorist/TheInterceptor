import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'

const repositoryRoot = process.cwd()

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPackageJson() {
	const packageJsonPath = path.join(repositoryRoot, 'package.json')
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
	if (!isRecord(packageJson)) throw new Error('package.json root must be an object')
	return packageJson
}

function getAppSource(relativePath: string) {
	return fs.readFileSync(path.join(repositoryRoot, 'app', 'ts', relativePath), 'utf8')
}

function getPackageScripts() {
	const packageJson = getPackageJson()
	const scripts = packageJson.scripts
	if (!isRecord(scripts)) throw new Error('package.json scripts must be an object')
	return scripts
}

function getScript(scripts: Record<string, unknown>, scriptName: string) {
	const script = scripts[scriptName]
	if (typeof script !== 'string') throw new Error(`Missing package script: ${ scriptName }`)
	return script
}

function getDependencyVersion(packageJson: Record<string, unknown>, dependencyName: string) {
	const dependencies = packageJson.dependencies
	const devDependencies = packageJson.devDependencies
	const version = isRecord(dependencies) && typeof dependencies[dependencyName] === 'string'
		? dependencies[dependencyName]
		: isRecord(devDependencies) && typeof devDependencies[dependencyName] === 'string'
			? devDependencies[dependencyName]
			: undefined
	if (version === undefined) throw new Error(`Missing package dependency: ${ dependencyName }`)
	return version
}

function parseExactMajorMinor(version: string) {
	const match = version.match(/^([0-9]+)\.([0-9]+)\.[0-9]+$/u)
	if (match?.[1] === undefined || match[2] === undefined) throw new Error(`Expected exact semantic version, got ${ version }`)
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
	}
}

describe('package scripts', () => {
	test('firefox build compiles app scripts before writing the manifest', () => {
		const scripts = getPackageScripts()

		assert.deepEqual(getScript(scripts, 'build-firefox').split(' && '), [
			'bun run compile-app',
			'bun run bundle',
			'bun run firefox',
		])
	})

	test('typescript is new enough for micro-eth-signer declarations', () => {
		const packageJson = getPackageJson()
		assert.equal(getDependencyVersion(packageJson, 'micro-eth-signer'), '0.19.0')

		const typescriptVersion = parseExactMajorMinor(getDependencyVersion(packageJson, 'typescript'))
		assert.equal(typescriptVersion.major, 5)
		assert.equal(typescriptVersion.minor >= 9, true)
	})

	test('local ENS normalizer keeps upstream license and data provenance', () => {
		const source = getAppSource('utils/ensNormalize.ts')
		for (const requiredText of [
			'Copyright (c) 2022 Raffy Antistupid.',
			'SPDX-License-Identifier: MIT',
			'Source package: @adraffy/ens-normalize@1.11.1',
			'Source tarball: https://registry.npmjs.org/@adraffy/ens-normalize/-/ens-normalize-1.11.1.tgz',
			'Source integrity: sha512-nhCBV3quEgesuf7c7KYfperqSS14T8bYuvJ8PcLJp6znkZpFc0AuW4qBtr8eKVyPPe/8RSr7sglCWPU5eaxwKQ==',
			'Source gitHead: 19daa8507f95d9432fcf1e59c9ac76131630c6da',
			'SHA-256: 92cbf3a1af3c3c0a91aee0dc542072775f4ebbbc526a84189a12da2d56f5accd',
			'SHA-256: 9ef43cc7215aa7a53e4ed9afa3b4f2f8ce00a2c708b9eb96aa409ae6fa3fb6af',
		]) {
			assert.equal(source.includes(requiredText), true, requiredText)
		}
	})

	test('app compilation keeps declaration output enabled through the project configuration', () => {
		const scripts = getPackageScripts()
		const configFile = ts.readConfigFile(path.join(repositoryRoot, 'tsconfig.json'), ts.sys.readFile)
		assert.equal(configFile.error, undefined)
		assert.ok(isRecord(configFile.config))
		const compilerOptions = configFile.config.compilerOptions
		assert.ok(isRecord(compilerOptions))

		assert.equal(getScript(scripts, 'compile-app'), 'bun run clean-js-output && bun --bun tsc --project tsconfig.json')
		assert.equal(compilerOptions.declaration, true)
		assert.equal(compilerOptions.declarationMap, true)
	})
})
