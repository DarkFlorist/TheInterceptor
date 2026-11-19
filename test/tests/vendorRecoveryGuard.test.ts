import * as assert from 'assert'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test } from 'bun:test'

test('a failed recovery preflight leaves existing vendor output intact', () => {
	const directory = fs.mkdtempSync(path.join(tmpdir(), 'interceptor-vendor-guard-'))
	try {
		for (const subdirectory of ['build', 'scripts', 'app/vendor']) fs.mkdirSync(path.join(directory, subdirectory), { recursive: true })
		fs.copyFileSync(path.resolve(import.meta.dir, '../../build/vendor.mts'), path.join(directory, 'build/vendor.mts'))
		fs.writeFileSync(path.join(directory, 'scripts/check-recovery-dependency.mts'), 'throw new Error(\'Deliberate recovery preflight failure\')\n')
		const sentinel = path.join(directory, 'app/vendor/sentinel.txt')
		fs.writeFileSync(sentinel, 'previous vendor output')
		const result = Bun.spawnSync([process.execPath, path.join(directory, 'build/vendor.mts')], { stdout: 'pipe', stderr: 'pipe' })
		assert.notEqual(result.exitCode, 0)
		assert.match(new TextDecoder().decode(result.stderr), /Deliberate recovery preflight failure/u)
		assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous vendor output')
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
