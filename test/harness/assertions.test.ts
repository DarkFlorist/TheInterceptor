import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { isObjectWithOptionalProperties, isRecord, readProperty, requireDefined } from './assertions.js'

describe('requireDefined', () => {
	test('returns defined values, including falsy ones', () => {
		assert.equal(requireDefined(0, 'a count'), 0)
		assert.equal(requireDefined('', 'a label'), '')
	})

	test('throws with the description when the value is undefined', () => {
		assert.throws(() => requireDefined([1, 2].at(5), 'the sixth entry'), /Missing the sixth entry/)
	})
})

describe('isRecord', () => {
	test('accepts plain objects and rejects arrays, null and primitives', () => {
		assert.equal(isRecord({ method: 'eth_chainId' }), true)
		assert.equal(isRecord([]), false)
		assert.equal(isRecord(null), false)
		assert.equal(isRecord('object'), false)
	})
})

describe('readProperty', () => {
	test('reads nested properties and returns undefined for missing levels', () => {
		const message = { data: { isOpen: true } }
		assert.equal(readProperty(readProperty(message, 'data'), 'isOpen'), true)
		assert.equal(readProperty(readProperty(message, 'missing'), 'isOpen'), undefined)
		assert.equal(readProperty(undefined, 'data'), undefined)
		assert.equal(readProperty('text', 'length'), undefined)
	})
})

describe('isObjectWithOptionalProperties', () => {
	test('narrows every object so the listed properties can be read', () => {
		const message: unknown = { method: 'popup_requestSettings' }
		if (!isObjectWithOptionalProperties<'method' | 'data'>(message)) throw new Error('Expected an object')
		assert.equal(message.method, 'popup_requestSettings')
		assert.equal(message.data, undefined)
		assert.equal(isObjectWithOptionalProperties(null), false)
		assert.equal(isObjectWithOptionalProperties(5), false)
	})
})
