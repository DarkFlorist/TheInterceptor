import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { setFirefoxViewport } from '../benchmarks/firefoxViewport.js'

const target = { innerWidth: 1280, innerHeight: 900 }
const tree = { contexts: [{ context: 'other', userContext: 'default' }, { context: 'target', userContext: 'selected-container' }] }

test('Firefox applies viewport emulation to the target’s actual user context, not the first or default context', async () => {
	const calls: { method: string, params: Record<string, unknown> }[] = []
	await setFirefoxViewport({ send: async (method, params) => {
		calls.push({ method, params })
		return method === 'browsingContext.getTree' ? tree : undefined
	} }, 'target', 1280, 900, async () => target)
	assert.deepEqual(calls, [
		{ method: 'browsingContext.getTree', params: { root: 'target', maxDepth: 0 } },
		{ method: 'browsingContext.setViewport', params: { userContexts: ['selected-container'], viewport: { width: 1280, height: 900 }, devicePixelRatio: 1 } },
	])
})

test('Firefox preserves narrow viewport requests without native window clamping', async () => {
	const updates: Record<string, unknown>[] = []
	for (const width of [220, 1280]) await setFirefoxViewport({ send: async (method, params) => {
		if (method === 'browsingContext.getTree') return tree
		updates.push(params)
		return undefined
	} }, 'target', width, 700, async () => ({ innerWidth: width, innerHeight: 700 }))
	assert.deepEqual(updates.map((update) => update.viewport), [{ width: 220, height: 700 }, { width: 1280, height: 700 }])
})

test('Firefox resolves each target’s scope independently and never applies an all-context override', async () => {
	const scopes: unknown[] = []
	for (const context of ['target', 'other']) await setFirefoxViewport({ send: async (method, params) => {
		if (method === 'browsingContext.getTree') return tree
		scopes.push(params.userContexts)
		return undefined
	} }, context, 1280, 900, async () => target)
	assert.deepEqual(scopes, [['selected-container'], ['default']])
})

test('Firefox verifies achieved content dimensions and reports mismatches explicitly', async () => {
	await assert.rejects(setFirefoxViewport({ send: async () => tree }, 'target', 1280, 900, async () => ({ innerWidth: 500, innerHeight: 900 })), /could not set viewport 1280x900; received 500x900/u)
})

test('Firefox validates requested dimensions, target user context and viewport replies before claiming success', async () => {
	for (const { width, height } of [{ width: 0, height: 900 }, { width: -1, height: 900 }, { width: 1.5, height: 900 }, { width: Number.NaN, height: 900 }, { width: 1280, height: 0 }, { width: 1280, height: 2.5 }]) await assert.rejects(setFirefoxViewport({ send: async () => { throw new Error('unexpected request') } }, 'target', width, height, async () => target), /Invalid Firefox requested viewport/u)
	for (const reply of [{}, { contexts: [] }, { contexts: [{ context: 'other', userContext: 'wrong' }] }, { contexts: [{ context: 'target', userContext: '' }] }]) await assert.rejects(setFirefoxViewport({ send: async () => reply }, 'target', 1280, 900, async () => target), /target browsing context’s user context/u)
	for (const reply of [undefined, {}, { innerWidth: 1280, innerHeight: Number.NaN }, { innerWidth: undefined, innerHeight: 900 }]) await assert.rejects(setFirefoxViewport({ send: async () => tree }, 'target', 1280, 900, async () => reply), /Invalid Firefox viewport/u)
})

test('Firefox scope, emulation and measurement failures propagate without fallback or skipped capture', async () => {
	for (const failingMethod of ['browsingContext.getTree', 'browsingContext.setViewport']) {
		const failure = new Error(`${ failingMethod }: unsupported operation`)
		await assert.rejects(setFirefoxViewport({ send: async (method) => {
			if (method === failingMethod) throw failure
			return tree
		} }, 'target', 1280, 900, async () => target), failure)
	}
	const failure = new Error('viewport measurement failed')
	await assert.rejects(setFirefoxViewport({ send: async () => tree }, 'target', 1280, 900, async () => { throw failure }), failure)
})
