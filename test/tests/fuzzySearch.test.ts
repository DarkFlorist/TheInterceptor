import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createFuzzySearchPattern } from '../../app/ts/utils/fuzzySearch.js'

describe('fuzzy search patterns', () => {
	test('treats astral Unicode characters as whole code points', () => {
		const pattern = createFuzzySearchPattern('🔒a')
		assert.notEqual(pattern, undefined)
		assert.equal(pattern?.test('wallet 🔒 account'), true)
	})

	test('treats regular-expression characters as literal search text', () => {
		const pattern = createFuzzySearchPattern('.*')
		assert.equal(pattern?.test('literal . dot and * asterisk'), true)
		assert.equal(pattern?.test('unrelated'), false)
	})
})
