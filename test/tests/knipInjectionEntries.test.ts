import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'bun:test'
import { INPAGE_SCRIPTS } from '../../app/ts/config/injectedScripts.js'

test('Knip tracks every configured injected bootstrap at its actual source path', () => {
	const config = fs.readFileSync('knip.jsonc', 'utf8')
	for (const artifact of Object.values(INPAGE_SCRIPTS)) {
		const source = artifact.replace('/inpage/js/', 'app/inpage/ts/').replace(/\.js$/, '.ts')
		assert.ok(fs.existsSync(source), source)
		assert.ok(config.includes(JSON.stringify(source)), `Knip entry missing: ${ source }`)
	}
})
