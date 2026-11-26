import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { parseBrowserEvaluationValue } from '../benchmarks/browserEvaluation.js'

test('shared browser evaluation values decode JSON and preserve undefined', () => {
	assert.deepEqual(parseBrowserEvaluationValue('{"values":[1,true,"value"]}'), { values: [1, true, 'value'] })
	assert.equal(parseBrowserEvaluationValue('42'), 42)
	assert.equal(parseBrowserEvaluationValue('"value"'), 'value')
	assert.equal(parseBrowserEvaluationValue(undefined), undefined)
})

test('malformed browser transport results remain explicit failures', () => {
	assert.throws(() => parseBrowserEvaluationValue(42), /did not return serialized JSON/)
	assert.throws(() => parseBrowserEvaluationValue('{broken'), SyntaxError)
})
