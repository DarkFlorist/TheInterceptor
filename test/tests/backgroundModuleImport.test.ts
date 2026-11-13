import * as assert from 'node:assert/strict'
import { test } from 'bun:test'

test('background request handling loads without browser globals or previously imported modules', async () => {
	// A fresh process prevents other tests from hiding eager browser initialization with their mocks or module cache.
	const moduleUrl = new URL('../../app/ts/background/background.ts', import.meta.url)
	const child = Bun.spawn([process.execPath, '-e', `await import(${ JSON.stringify(moduleUrl.href) })`], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
	assert.equal(exitCode, 0, stderr)
})
