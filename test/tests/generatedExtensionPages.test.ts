import * as assert from 'assert'
import { test } from 'bun:test'

test('checked-in extension pages match their shared generator', async () => {
	const childProcess = Bun.spawn({
		cmd: [process.execPath, './scripts/generate-extension-pages.mts', '--check'],
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stderr] = await Promise.all([
		childProcess.exited,
		new Response(childProcess.stderr).text(),
	])
	assert.equal(exitCode, 0, stderr)
})
