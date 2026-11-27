import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Every shared scenario is defined once and executed on every supported browser. Platform exceptions must explain the browser API they specifically exercise.
export const sharedBrowserScenarios = [
	{ id: 'browser-harness-contract', script: 'test:browser:harness-contract', args: [] },
	{ id: 'provider-injection', script: 'test:browser:provider-injection', args: [] },
	{ id: 'wallet-signing', script: 'test:browser:wallet-signing', args: [] },
	{ id: 'gnosis-safe-hosting', script: 'test:browser:native-hosting', args: [] },
	{ id: 'rpc-communication', script: 'test:browser:rpc-communication', args: [] },
] as const

export const browserSpecificChecks = [
	{ engine: 'chrome', script: 'test:chrome-communication', reason: 'Exercises MV3 native MAIN/ISOLATED script registration, IPv6 registration and service-worker startup; Firefox MV2 uses different APIs and a persistent background page.' },
] as const

export const browserTestTargets = [
	{ browser: 'Chrome MV3', engine: 'chrome', manifestVersion: 3, build: 'setup-chrome' },
	{ browser: 'Firefox MV2', engine: 'firefox', manifestVersion: 2, build: 'setup-firefox' },
] as const

type BrowserTestFailure = { readonly browser: string, readonly step: string, readonly exitCode?: number, readonly error?: string }

// Builds share an output directory. Finish one browser before building the next; failures are recorded explicitly and never prevent the other browser from running.
export async function runBrowserTests(runScript: (script: string, args?: readonly string[]) => Promise<number>, readManifestVersion: () => Promise<unknown>, selectedScenarios?: readonly string[]) {
	if (selectedScenarios?.some((id) => !sharedBrowserScenarios.some((scenario) => scenario.id === id))) throw new Error('Unknown browser scenario')
	const scenarios = sharedBrowserScenarios.filter(({ id }) => selectedScenarios === undefined || selectedScenarios.includes(id))
	const failures: BrowserTestFailure[] = []
	for (const target of browserTestTargets) {
		const run = async (script: string, args: readonly string[] = []) => {
			try {
				const exitCode = await runScript(script, args)
				if (exitCode === 0) return true
				failures.push({ browser: target.browser, step: script, exitCode })
			} catch (error: unknown) { failures.push({ browser: target.browser, step: script, error: String(error) }) }
			return false
		}
		if (!await run(target.build)) continue
		try {
			if (await readManifestVersion() !== target.manifestVersion) { failures.push({ browser: target.browser, step: 'manifest version validation' }); continue }
		} catch (error: unknown) { failures.push({ browser: target.browser, step: 'manifest version validation', error: String(error) }); continue }
		for (const scenario of scenarios) await run(scenario.script, [`--browser=${ target.engine }`, ...scenario.args])
		if (selectedScenarios === undefined) for (const check of browserSpecificChecks) if (check.engine === target.engine) await run(check.script)
	}
	return failures
}

async function main() {
	const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
	const manifestPath = path.join(projectRoot, 'app/manifest.json')
	const manifest = Bun.file(manifestPath)
	const previousManifest = await manifest.exists() ? await manifest.text() : await Bun.file(path.join(projectRoot, 'app/manifestV3.json')).text()
	try {
		const requested = process.argv.filter((arg) => arg.startsWith('--scenario=')).flatMap((arg) => arg.slice('--scenario='.length).split(','))
		const failures = await runBrowserTests(async (script, args = []) => {
			console.log(`Browser tests: ${ script } ${ args.join(' ') }`)
			return await Bun.spawn({ cmd: [process.execPath, 'run', script, ...args], cwd: projectRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited
		}, async () => {
			const value: unknown = await Bun.file(manifestPath).json()
			return typeof value === 'object' && value !== null && 'manifest_version' in value ? value.manifest_version : undefined
		}, requested.length === 0 ? undefined : requested)
		if (failures.length > 0) throw new Error(`Browser checks failed: ${ failures.map(({ browser, step, exitCode, error }) => `${ browser }: ${ step }${ exitCode === undefined ? '' : ` (exit ${ exitCode })` }${ error === undefined ? '' : `: ${ error }` }`).join('; ') }`)
		console.log('Chrome MV3 and Firefox MV2 browser tests passed. Every shared scenario passed on both browsers; platform-specific checks are declared with reasons.')
	} finally {
		// Both builds produce the same bundles and differ in their generated manifest; restore the caller's manifest, including on test failure.
		await Bun.write(manifestPath, previousManifest)
	}
}

if (import.meta.main) await main()
