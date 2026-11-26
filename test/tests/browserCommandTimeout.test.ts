import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { withBrowserCommandTimeout } from '../benchmarks/browserCommandTimeout.js'

test('a per-call deadline allows an intentional evaluation longer than a shorter transport deadline', async () => {
	const work = () => new Promise<string>((resolve) => setTimeout(() => resolve('complete'), 20))
	await assert.rejects(withBrowserCommandTimeout(work(), 'evaluation', 5), /evaluation timed out after 5 milliseconds/)
	assert.equal(await withBrowserCommandTimeout(work(), 'evaluation', 100), 'complete')
})

test('command deadlines retain operation failures and values', async () => {
	const failure = new Error('script failed')
	await assert.rejects(withBrowserCommandTimeout(Promise.reject(failure), 'evaluation', 100), failure)
	assert.equal(await withBrowserCommandTimeout(Promise.resolve(42), 'evaluation'), 42)
})
