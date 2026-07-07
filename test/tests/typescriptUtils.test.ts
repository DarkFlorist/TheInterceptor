import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { isNumberOrBigint } from '../../app/ts/utils/typescript.js'

describe('typescript utils', () => {
	test('isNumberOrBigint accepts numeric primitive values', () => {
		assert.equal(isNumberOrBigint(6), true)
		assert.equal(isNumberOrBigint(6n), true)
		assert.equal(isNumberOrBigint('6'), false)
	})
})
