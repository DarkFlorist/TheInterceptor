import * as assert from 'assert'
import { test } from 'bun:test'
import { createMethodHandlerFor, hasOwnKey } from '../../app/ts/utils/methodHandlers.js'

type TestMessage =
	| { readonly method: 'double', readonly value: number }
	| { readonly method: 'length', readonly value: string }

type TestHandler = (context: number, message: TestMessage) => number
const testHandler = createMethodHandlerFor<TestMessage, number, number>()

const handlers = {
	double: testHandler('double', (context, message) => context + message.value * 2),
	length: testHandler('length', (context, message) => context + message.value.length),
} as const satisfies Record<TestMessage['method'], TestHandler>

test('method handler tables dispatch narrowed messages and reject mismatched direct calls', () => {
	assert.equal(handlers.double(1, { method: 'double', value: 3 }), 7)
	assert.equal(handlers.length(1, { method: 'length', value: 'abc' }), 4)
	assert.throws(
		() => handlers.double(1, { method: 'length', value: 'abc' }),
		/Handler for double received length/,
	)
})

test('handler table key checks reject properties inherited from Object.prototype', () => {
	assert.equal(hasOwnKey(handlers, 'double'), true)
	assert.equal(hasOwnKey(handlers, 'toString'), false)
	assert.equal(hasOwnKey(handlers, 'constructor'), false)
})
