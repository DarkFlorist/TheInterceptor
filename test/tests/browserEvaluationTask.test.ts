import { chromeEvaluationFailure } from '../benchmarks/chromeEvaluationFailure.js'
import { firefoxEvaluationFailure } from '../benchmarks/firefoxEvaluationFailure.js'
import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { evaluateBrowserTask } from '../benchmarks/browserEvaluationTask.js'
import { waitForBrowserCondition } from '../benchmarks/browserHarnessUtils.js'

const page = { id: 'page', url: 'about:blank', evaluate: async () => undefined, navigate: async () => undefined, reload: async () => undefined, captureScreenshot: async () => '', close: async () => undefined }

for (const message of ['Execution context was destroyed', 'Cannot find context with specified id', 'Cannot find default execution context', 'no such frame', 'Firefox BiDi script.evaluate: Browsing context has been discarded', 'Firefox BiDi script.evaluate: Evaluation was abandoned']) test(`observations retry known navigation loss: ${ message }`, async () => {
	const failure = message.startsWith('Firefox BiDi ') ? firefoxEvaluationFailure(new Error(message)) : chromeEvaluationFailure(new Error(message))
	let calls = 0
	await waitForBrowserCondition(async () => {
		if (++calls === 1) throw failure
		return true
	}, 'document after navigation', 1000)
	assert.equal(calls, 2)
	assert.deepEqual(await evaluateBrowserTask(async () => { throw failure }, { kind: 'navigation' }), { kind: 'retry-navigation' })
	await assert.rejects(evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session: { pages: async () => [page] }, pageId: page.id }), failure, 'an interrupted approval cannot be replayed while its page remains open')
	assert.deepEqual(await evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session: { pages: async () => [] }, pageId: page.id }), { kind: 'closed' })
})

test('recognized navigation loss reaches the normal condition deadline rather than completing the wait', async () => {
	await assert.rejects(waitForBrowserCondition(async () => { throw chromeEvaluationFailure(new Error('Cannot find context with specified id')) }, 'reloaded page', 0), /Timed out waiting for reloaded page/)
})

test('terminal target loss requires explicit page enumeration and is never retried as navigation', async () => {
	for (const message of ['CDP websocket closed for ws://127.0.0.1/devtools/page/1', 'Target closed.', 'Session closed']) {
		const failure = message.startsWith('Firefox BiDi ') ? firefoxEvaluationFailure(new Error(message)) : chromeEvaluationFailure(new Error(message))
		let enumerations = 0
		assert.deepEqual(await evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session: { pages: async () => { enumerations++; return [] } }, pageId: page.id }), { kind: 'closed' })
		assert.equal(enumerations, 1)
		await assert.rejects(evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session: { pages: async () => [page] }, pageId: page.id }), failure)
		await assert.rejects(waitForBrowserCondition(async () => { throw failure }, 'page response', 0), failure)
	}
})

test('Firefox missing browsing context after an approval requires verified closure and never replays the evaluation', async () => {
	const failure = firefoxEvaluationFailure(new Error('Firefox BiDi script.evaluate: Browsing Context with id e9bd1bbf-ead2-4fbc-a266-84c4d39f8da9 not found'))
	let evaluations = 0
	let enumerations = 0
	const evaluate = async () => { evaluations++; throw failure }
	assert.deepEqual(await evaluateBrowserTask(evaluate, { kind: 'page-close', session: { pages: async () => { enumerations++; return [] } }, pageId: page.id }), { kind: 'closed' })
	assert.equal(evaluations, 1)
	assert.equal(enumerations, 1)
	await assert.rejects(evaluateBrowserTask(evaluate, { kind: 'page-close', session: { pages: async () => { enumerations++; return [page] } }, pageId: page.id }), failure)
	assert.equal(evaluations, 2)
	assert.equal(enumerations, 2)
	await assert.rejects(evaluateBrowserTask(evaluate, { kind: 'navigation' }), failure)
	assert.equal(evaluations, 3)
	assert.equal(enumerations, 2)
	await assert.rejects(waitForBrowserCondition(evaluate, 'approval response', 1000), failure)
	assert.equal(evaluations, 4)
})

test('business errors mentioning closed, frame, context or abandoned remain failures even after page closure', async () => {
	for (const failure of [new Error('Application channel closed'), new Error('Browsing Context with id e9bd1bbf-ead2-4fbc-a266-84c4d39f8da9 not found'), new Error('Application error: Firefox BiDi script.evaluate: Browsing Context with id e9bd1bbf-ead2-4fbc-a266-84c4d39f8da9 not found'), new Error('Invalid frame value'), new Error('The business context is missing'), new Error('Request abandoned by application'), new Error('Firefox WebDriver BiDi connection closed.'), 'closed']) {
		let enumerations = 0
		const session = { pages: async () => { enumerations++; return [] } }
		await assert.rejects(evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session, pageId: page.id }), (error) => error === failure)
		await assert.rejects(waitForBrowserCondition(async () => { throw failure }, 'business condition', 0), (error) => error === failure)
		assert.equal(enumerations, 0, 'unexpected failures do not turn into page-closure checks')
	}
})

test('page enumeration failures propagate instead of pretending that an approval page closed', async () => {
	const failure = new Error('Cannot enumerate browser pages')
	await assert.rejects(evaluateBrowserTask(async () => { throw chromeEvaluationFailure(new Error('Execution context was destroyed')) }, { kind: 'page-close', session: { pages: async () => { throw failure } }, pageId: page.id }), failure)
})

test('successful evaluations preserve both values and undefined', async () => {
	assert.deepEqual(await evaluateBrowserTask(async () => false, { kind: 'navigation' }), { kind: 'value', value: false })
	assert.deepEqual(await evaluateBrowserTask(async () => undefined, { kind: 'page-close', session: { pages: async () => [] }, pageId: page.id }), { kind: 'value', value: undefined })
})


test('unmarked page exceptions that imitate protocol failures are never retried', async () => {
	for (const message of ['Execution context was destroyed', 'Target closed.', 'Firefox BiDi script.evaluate: Evaluation was abandoned']) {
		const failure = new Error(message)
		await assert.rejects(evaluateBrowserTask(async () => { throw failure }, { kind: 'navigation' }), failure)
		await assert.rejects(evaluateBrowserTask(async () => { throw failure }, { kind: 'page-close', session: { pages: async () => [] }, pageId: page.id }), failure)
	}
})
