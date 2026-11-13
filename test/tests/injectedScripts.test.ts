import * as assert from 'assert'
import * as fs from 'node:fs'
import { test } from 'bun:test'
import { INPAGE_RUNTIME_SCRIPTS } from '../../build/bundler.mts'
import { INPAGE_SCRIPTS } from '../../app/ts/config/injectedScripts.js'

test('the runtime bundler lists exactly the injected scripts Chrome loads', () => {
	assert.deepEqual(INPAGE_RUNTIME_SCRIPTS, INPAGE_SCRIPTS)
})

test('every injected script is emitted from an app/inpage/ts source', () => {
	for (const file of Object.values(INPAGE_SCRIPTS)) {
		const sourcePath = file.replace(/^\/inpage\/js\//, 'app/inpage/ts/').replace(/\.js$/, '.ts')
		assert.ok(fs.existsSync(sourcePath), `${ file } has no source at ${ sourcePath }`)
	}
})
