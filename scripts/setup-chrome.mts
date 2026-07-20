import * as path from 'node:path'
import * as url from 'node:url'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')

type PhaseResult = {
	name: string
	durationMilliseconds: number
}

async function runPackageScript(scriptName: string) {
	const startTime = performance.now()
	const subprocess = Bun.spawn({
		cmd: [process.execPath, 'run', scriptName],
		cwd: projectRoot,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	const exitCode = await subprocess.exited
	if (exitCode !== 0) throw new Error(`Package script failed: ${ scriptName }`)
	return {
		name: scriptName,
		durationMilliseconds: performance.now() - startTime,
	} satisfies PhaseResult
}

function printProfile(results: readonly PhaseResult[], totalDurationMilliseconds: number) {
	console.log('\nsetup-chrome profile')
	for (const result of results) {
		console.log(`${ result.name.padEnd(20) }${ (result.durationMilliseconds / 1000).toFixed(2).padStart(8) } s`)
	}
	console.log(`${ 'total'.padEnd(20) }${ (totalDurationMilliseconds / 1000).toFixed(2).padStart(8) } s`)
}

async function setupChrome(profile: boolean) {
	const setupStartTime = performance.now()
	const preparationStartTime = performance.now()
	const settledPreparationResults = await Promise.allSettled([
		runPackageScript('vendor'),
		runPackageScript('inpage'),
		runPackageScript('compile-app'),
	])
	const failedPreparationResult = settledPreparationResults.find((result) => result.status === 'rejected')
	if (failedPreparationResult !== undefined) throw failedPreparationResult.reason
	const preparationResults = settledPreparationResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
	const preparationResult = {
		name: 'parallel preparation',
		durationMilliseconds: performance.now() - preparationStartTime,
	} satisfies PhaseResult
	const bundleResult = await runPackageScript('bundle')
	const chromeResult = await runPackageScript('chrome')
	if (profile) printProfile(
		[...preparationResults, preparationResult, bundleResult, chromeResult],
		performance.now() - setupStartTime,
	)
}

setupChrome(process.argv.includes('--profile')).catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
