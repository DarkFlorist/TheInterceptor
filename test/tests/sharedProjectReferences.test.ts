import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { compileTypeScriptProject } from '../../scripts/compile-typescript.mjs'
import { buildRuntimeEntrypoints } from '../../build/bundler.mts'

function readProject(configFile: string) {
	const project = ts.getParsedCommandLineOfConfigFile(path.resolve(configFile), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
	})
	assert.ok(project)
	assert.deepEqual(project.errors, [])
	return project
}

test('the Docker build copies the complete TypeScript configuration graph used by its build scripts', () => {
	const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
	const copiedRootFiles = new Set([...dockerfile.matchAll(/^COPY\s+(.+)\s+\/workspace\/\s*$/gmu)].flatMap((match) => (match[1] ?? '').split(/\s+/u).map((file) => file.replace(/^\.\//u, ''))))
	assert.ok(copiedRootFiles.has('Dockerfile'), 'Docker-hosted tests must receive the Dockerfile they validate')
	const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
	const scripts: Readonly<Record<string, unknown>> = packageJson.scripts
	const pending: string[] = []
	for (const scriptName of ['compile-app', 'inpage']) {
		const command = scripts[scriptName]
		assert.ok(typeof command === 'string')
		const configuration = command.match(/\bcompile-typescript\.mts\s+([^\s]+)/u)?.[1]
		assert.ok(configuration, `${ scriptName } must identify its TypeScript build configuration`)
		pending.push(path.resolve(configuration))
	}
	const visited = new Set<string>()
	while (pending.length > 0) {
		const configFile = pending.pop()
		assert.ok(configFile)
		if (visited.has(configFile)) continue
		visited.add(configFile)
		assert.ok(copiedRootFiles.has(path.relative(process.cwd(), configFile)), `Docker must copy ${ path.basename(configFile) } before compiling the extension`)
		const project = readProject(configFile)
		const extended: unknown = project.raw?.extends
		if (extended !== undefined) {
			assert.ok(typeof extended === 'string')
			pending.push(path.resolve(path.dirname(configFile), extended))
		}
		for (const reference of project.projectReferences ?? []) pending.push(ts.resolveProjectReferencePath(reference))
	}
})

test('inpage protocol consumers import the canonical shared source without local facades', () => {
	const directory = 'app/inpage/ts'
	for (const file of fs.readdirSync(directory).filter((candidate) => candidate.endsWith('.ts'))) {
		const imports = ts.preProcessFile(fs.readFileSync(path.join(directory, file), 'utf8')).importedFiles
		for (const dependency of imports) {
			const sharedModule = dependency.fileName.match(/(?:^|\/)(gnosisSafeApps(?:Protocol|RequestQueue|Transport))\.js$/u)?.[1]
			if (sharedModule !== undefined) assert.equal(dependency.fileName, `../../shared/ts/${ sharedModule }.js`, `${ file } must import the shared source directly`)
		}
	}
})

test('both build graphs reference the shared owner while source-only checking needs no generated artifacts', () => {
	const shared = readProject('tsconfig-shared.json')
	assert.equal(shared.options.composite, true)
	assert.equal(shared.options.declaration, true)
	assert.ok(shared.options.tsBuildInfoFile?.startsWith(path.resolve('app/shared/js')))
	const sourceFiles = new Set(shared.fileNames)
	const consumers = [
		{ config: 'tsconfig-inpage.json', build: 'tsconfig-inpage-build.json', sources: ['app/inpage/ts/inpage.ts', 'app/inpage/ts/nativeGnosisSafeAppsSourceBridge.ts', 'app/inpage/ts/listenContentScript.ts'] },
		{ config: 'tsconfig.json', build: 'tsconfig-app-build.json', sources: ['app/ts/background/accountRequestMethods.ts', 'app/ts/utils/nativeGnosisSafeAppsHost.ts'] },
	]
	for (const consumer of consumers) {
		const project = readProject(consumer.config)
		assert.equal(project.options.noEmit, true)
		assert.equal(project.projectReferences, undefined, 'source checking must not redirect imports to generated declarations')
		const build = readProject(consumer.build)
		assert.ok(build.projectReferences?.some((reference) => reference.path === path.resolve('tsconfig-shared.json')), `${ consumer.build } must reference the shared owner`)
		for (const file of consumer.sources) {
			const imports = ts.preProcessFile(fs.readFileSync(file, 'utf8')).importedFiles.filter((dependency) => dependency.fileName.includes('/shared/ts/'))
			assert.ok(imports.length > 0, `${ file } must consume the shared project`)
			for (const dependency of imports) {
				const sourceFile = path.resolve(path.dirname(file), dependency.fileName.replace(/\.js$/u, '.ts'))
				assert.ok(sourceFiles.has(sourceFile), `${ sourceFile } has no source owner in the referenced project`)
				const resolution = ts.resolveModuleName(dependency.fileName, path.resolve(file), project.options, {
					...ts.sys,
					fileExists: (candidate) => !candidate.startsWith(path.resolve('app/shared/js')) && ts.sys.fileExists(candidate),
				})
				assert.equal(resolution.resolvedModule?.resolvedFileName, sourceFile, 'module resolution must reach source with shared outputs unavailable')
			}
		}
	}
})

test('a clean source graph checks without shared output and emitted consumers bundle without shipping source files', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-source-graph-'))
	const write = (file: string, contents: string) => {
		fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
		fs.writeFileSync(path.join(directory, file), contents)
	}
	const source = 'export const normalize = (value: string) => `${ value }:source`\n'
	try {
		write('shared/ts/protocol.ts', source)
		write('consumer/ts/index.ts', 'import { normalize } from \'../../shared/ts/protocol.js\'\nconsole.log(normalize(\'sdk\'))\n')
		const options = { strict: true, target: 'ES2021', module: 'ESNext', moduleResolution: 'Bundler', types: [] }
		write('tsconfig-source.json', JSON.stringify({ compilerOptions: { ...options, rootDir: '.', noEmit: true }, include: ['consumer/ts/**/*.ts'] }))
		write('tsconfig-shared.json', JSON.stringify({ compilerOptions: { ...options, rootDir: 'shared/ts', outDir: 'shared/js', composite: true, declaration: true, tsBuildInfoFile: 'shared/js/build.tsbuildinfo' }, include: ['shared/ts/**/*.ts'] }))
		write('tsconfig-build.json', JSON.stringify({ compilerOptions: { ...options, rootDir: 'consumer/ts', outDir: 'consumer/js', tsBuildInfoFile: 'consumer/js/build.tsbuildinfo' }, include: ['consumer/ts/**/*.ts'], references: [{ path: './tsconfig-shared.json' }] }))
		const check = () => {
			const project = readProject(path.join(directory, 'tsconfig-source.json'))
			return ts.getPreEmitDiagnostics(ts.createProgram(project.fileNames, project.options))
		}
		assert.equal(fs.existsSync(path.join(directory, 'shared/js')), false)
		assert.deepEqual(check(), [], 'source checking must work before any shared artifacts exist')
		assert.equal(compileTypeScriptProject(path.join(directory, 'tsconfig-build.json')), 0)
		for (const extension of ['js', 'd.ts']) write(`shared/js/obsolete.${ extension }`, 'obsolete')
		const protocolOutput = fs.readFileSync(path.join(directory, 'shared/js/protocol.js'), 'utf8')
		assert.equal(compileTypeScriptProject(path.join(directory, 'tsconfig-build.json')), 0)
		assert.equal(fs.readFileSync(path.join(directory, 'shared/js/protocol.js'), 'utf8'), protocolOutput, 'an incremental no-op must retain current output')
		assert.equal(fs.existsSync(path.join(directory, 'shared/js/protocol.d.ts')), true)
		assert.equal(fs.existsSync(path.join(directory, 'shared/js/build.tsbuildinfo')), true)
		for (const extension of ['js', 'd.ts']) assert.equal(fs.existsSync(path.join(directory, `shared/js/obsolete.${ extension }`)), false)
		write('shared/ts/protocol.ts', 'export const normalize = (value: number) => value\n')
		assert.ok(check().some((diagnostic) => diagnostic.code === 2345), 'a source signature change must invalidate consumers even with old declarations present')
		write('shared/ts/protocol.ts', source)
		const entrypoint = path.join(directory, 'consumer/js/index.js')
		assert.match(fs.readFileSync(entrypoint, 'utf8'), /shared\/ts\/protocol\.js/u)
		const bundles = await buildRuntimeEntrypoints([entrypoint], { root: directory, outdir: path.join(directory, 'bundles'), inpagePath: path.join(directory, 'unused-provider.js'), documentStartPath: path.join(directory, 'unused-document-start.js') })
		const bundle = bundles[0]
		assert.ok(bundle)
		const runtime = fs.readFileSync(bundle.bundledEntrypointPath, 'utf8')
		assert.doesNotMatch(runtime, /(?:import|export)\s.*from\s/u)
		fs.rmSync(path.join(directory, 'shared'), { recursive: true })
		const values: unknown[] = []
		runInNewContext(runtime, { console: { log: (value: unknown) => values.push(value) } })
		assert.deepEqual(values, ['sdk:source'], 'the runtime bundle must execute with neither shared source nor generated shared modules available')
	} finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
