import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'

test('confirmation presentation uses shared request identity without importing background storage', () => {
	const source = readFileSync('app/ts/components/pages/ConfirmTransaction.tsx', 'utf8')
	assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/background\/storageVariables\.js['"]/u)
	assert.match(source, /import \{[^}]*\bisSamePendingRequestInstance\b[^}]*\} from ['"]\.\.\/\.\.\/utils\/requests\.js['"]/u)
})
