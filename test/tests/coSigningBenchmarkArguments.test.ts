import * as assert from 'node:assert/strict'
import { test } from 'bun:test'

test('obsolete co-signing hosting modes fail immediately with the shared native browser runner', () => {
	const result = Bun.spawnSync([process.execPath, new URL('../benchmarks/chromeGnosisSafeCoSigningCommunication.ts', import.meta.url).pathname, '--request-finance-discovery'], { stdout: 'pipe', stderr: 'pipe' })
	assert.notEqual(result.exitCode, 0)
	const error = result.stderr.toString()
	assert.match(error, /This co-signing benchmark accepts no flags/)
	assert.match(error, /bun run test:browser:native-hosting/)
	assert.doesNotMatch(error, /Timed out|Could not find.*(?:Chrome|Chromium)/)
})
