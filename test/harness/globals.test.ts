import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { replaceGlobal, replaceProperty } from './globals.js'

describe('property replacement', () => {
	test('replaceProperty puts back an existing property', () => {
		const target = { greet: () => 'original' }
		const restore = replaceProperty(target, 'greet', () => 'replaced')
		assert.equal(target.greet(), 'replaced')

		restore()

		assert.equal(target.greet(), 'original')
	})

	test('replaceGlobal removes a global that did not exist before', () => {
		const key = Symbol('harness-test-global')
		const restore = replaceGlobal(key, 'installed')
		assert.equal(Reflect.get(globalThis, key), 'installed')

		restore()

		assert.equal(Reflect.has(globalThis, key), false)
	})
})
