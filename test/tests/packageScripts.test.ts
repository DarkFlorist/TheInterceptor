import * as assert from 'assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import { prepareExtensionPackage } from '../../build/pruneExtensionPackage.mts'

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

function readJsonFile(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getManifest(manifestName: string) {
	const manifest = readJsonFile(path.join(repositoryRoot, 'app', manifestName))
	if (!isRecord(manifest)) throw new Error(`${ manifestName } root must be an object`)
	return manifest
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

	test('manifests only expose the inpage provider script to websites', () => {
		const manifestV2 = getManifest('manifestV2.json')
		const manifestV3 = getManifest('manifestV3.json')

		assert.deepEqual(manifestV2.web_accessible_resources, ['inpage/js/inpage.js'])
		assert.deepEqual(manifestV3.web_accessible_resources, [{
			resources: ['inpage/js/inpage.js'],
			matches: ['<all_urls>'],
		}])
	})

	test('extension package pruning removes source and metadata from staged app copies', async () => {
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-package-'))
		try {
			const sourceDirectory = path.join(tempDirectory, 'source-app')
			const destinationDirectory = path.join(tempDirectory, 'package-app')
			for (const directory of [
				'ts',
				'inpage/ts',
				'inpage/js',
				'js',
				'vendor/example-package/dist',
				'vendor/example-package/src',
				'vendor/@darkflorist/address-metadata/images/tokens',
				'vendor/@darkflorist/address-metadata/lib/images/tokens',
			]) {
				fs.mkdirSync(path.join(sourceDirectory, directory), { recursive: true })
			}
			for (const [relativePath, contents] of Object.entries({
				'manifest.json': '{}',
				'manifestV2.json': '{}',
				'manifestV3.json': '{}',
				'ts/source.ts': 'export {}',
				'inpage/ts/inpage.ts': 'export {}',
				'inpage/js/inpage.js': 'globalThis.ethereum = {}',
				'inpage/js/inpage.js.map': '{}',
				'js/popup.js': 'export {}',
				'js/popup.d.ts': 'export {}',
				'js/popup.js.map': '{}',
				'vendor/example-package/package.json': '{}',
				'vendor/example-package/dist/index.js': 'export {}',
				'vendor/example-package/dist/index.d.ts': 'export {}',
				'vendor/example-package/src/index.ts': 'export {}',
				'vendor/@darkflorist/address-metadata/images/tokens/token.png': 'image',
				'vendor/@darkflorist/address-metadata/lib/images/tokens/token.png': 'duplicate image',
			})) {
				fs.writeFileSync(path.join(sourceDirectory, relativePath), contents)
			}

			await prepareExtensionPackage(sourceDirectory, destinationDirectory)

			assert.equal(fs.existsSync(path.join(destinationDirectory, 'manifest.json')), true)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'manifestV2.json')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'manifestV3.json')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'ts')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'inpage/ts')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'inpage/js/inpage.js')), true)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'inpage/js/inpage.js.map')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'js/popup.js')), true)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'js/popup.d.ts')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'js/popup.js.map')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/example-package/package.json')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/example-package/dist/index.js')), true)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/example-package/dist/index.d.ts')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/example-package/src')), false)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/@darkflorist/address-metadata/images/tokens/token.png')), true)
			assert.equal(fs.existsSync(path.join(destinationDirectory, 'vendor/@darkflorist/address-metadata/lib/images')), false)
		} finally {
			fs.rmSync(tempDirectory, { recursive: true, force: true })
		}
	})
})
