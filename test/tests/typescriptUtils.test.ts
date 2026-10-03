import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { hasOwnKey, isNumberOrBigint } from '../../app/ts/utils/typescript.js'

describe('typescript utils', () => {
	test('isNumberOrBigint accepts numeric primitive values', () => {
		assert.equal(isNumberOrBigint(6), true)
		assert.equal(isNumberOrBigint(6n), true)
		assert.equal(isNumberOrBigint('6'), false)
	})

	test('hasOwnKey rejects properties inherited from Object.prototype', () => {
		const value = { ownProperty: true }
		assert.equal(hasOwnKey(value, 'ownProperty'), true)
		assert.equal(hasOwnKey(value, 'toString'), false)
		assert.equal(hasOwnKey(value, 'constructor'), false)
	})
})
