import * as assert from 'assert'
import { test } from 'bun:test'
import { browserSpecificChecks, browserTestTargets, runBrowserTests, sharedBrowserScenarios } from '../../scripts/test-browsers.mts'

for (const failure of ['none', 'chrome-build', 'chrome-test', 'wrong-manifest', 'spawn', 'manifest-read'] as const) test(`shared browser matrix attempts both engines after ${ failure }`, async () => {
	const commands: { script: string, args: readonly string[] }[] = []
	let version = 0
	const failures = await runBrowserTests(async (script, args = []) => {
		commands.push({ script, args })
		if (script === 'setup-chrome') { version = failure === 'wrong-manifest' ? 2 : 3; if (failure === 'chrome-build') return 1 }
		if (script === 'setup-firefox') version = 2
		if (args.includes('--browser=chrome') && script === sharedBrowserScenarios[0].script) {
			if (failure === 'spawn') throw new Error('Browser failed to launch')
			if (failure === 'chrome-test') return 1
		}
		return 0
	}, async () => { if (failure === 'manifest-read' && version === 3) throw new SyntaxError('Invalid generated manifest'); return version })
	assert.equal(failures.length, failure === 'none' ? 0 : 1)
	const chromeSkipped = ['chrome-build', 'wrong-manifest', 'manifest-read'].includes(failure)
	for (const target of browserTestTargets) for (const scenario of sharedBrowserScenarios) {
		assert.equal(commands.some(({ script, args }) => script === scenario.script && JSON.stringify(args) === JSON.stringify([`--browser=${ target.engine }`, ...scenario.args])), target.engine === 'firefox' || !chromeSkipped)
	}
	assert.ok(commands.some(({ script }) => script === 'setup-firefox'))
})

test('a scenario filter still runs the same scenario on both browsers', async () => {
	let version = 0
	const recorded: string[][] = []
	await runBrowserTests(async (script, args = []) => { if (script === 'setup-chrome') version = 3; if (script === 'setup-firefox') version = 2; recorded.push([script, ...args]); return 0 }, async () => version, ['provider-injection'])
	assert.equal(recorded.filter(([script]) => script === 'test:browser:provider-injection').length, 2)
	assert.deepEqual(recorded.filter(([script]) => script === 'test:browser:provider-injection').map(([, engine]) => engine), ['--browser=chrome', '--browser=firefox'])
	assert.equal(recorded.some(([script]) => script === 'test:chrome-communication'), false)
})

test('every browser-only exception explains its platform-specific API', () => {
	assert.ok(browserSpecificChecks.every(({ reason }) => reason.trim().length > 0))
	assert.ok(browserSpecificChecks.every(({ engine }) => browserTestTargets.some((target) => target.engine === engine)))
})

test('a Firefox failure makes the paired run fail after Chrome succeeds', async () => {
	let version = 0
	const failures = await runBrowserTests(async (script, args = []) => {
		if (script === 'setup-chrome') version = 3
		if (script === 'setup-firefox') version = 2
		return script === 'test:browser:wallet-signing' && args.includes('--browser=firefox') ? 2 : 0
	}, async () => version)
	assert.deepEqual(failures, [{ browser: 'Firefox MV2', step: 'test:browser:wallet-signing', exitCode: 2 }])
})
