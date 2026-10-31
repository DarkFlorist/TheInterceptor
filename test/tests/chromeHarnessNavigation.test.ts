import * as assert from 'assert'
import { test } from 'bun:test'
import { evaluateWhileNavigating } from '../benchmarks/chromeHarness.js'

for (const message of [
	'Execution context was destroyed.',
	'Cannot find context with specified id',
	'Inspected target navigated or closed',
]) test(`navigation evaluation retries after: ${ message }`, async () => {
	assert.equal(await evaluateWhileNavigating(async () => { throw new Error(message) }), undefined)
})

test('navigation evaluation preserves successful results', async () => {
	assert.equal(await evaluateWhileNavigating(async () => true), true)
})

test('navigation evaluation propagates unrelated failures', async () => {
	await assert.rejects(evaluateWhileNavigating(async () => { throw new Error('CDP websocket closed') }), /CDP websocket closed/)
})
