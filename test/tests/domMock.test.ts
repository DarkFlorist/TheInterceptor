import * as assert from 'assert'
import { test } from 'bun:test'
import { installDomMock } from './domMock.js'

test('installDomMock restore keeps newer interleaved mock globals active', () => {
	const first = installDomMock()
	const firstSetInterval = globalThis.setInterval
	const firstClearInterval = globalThis.clearInterval
	const firstRequestAnimationFrame = globalThis.requestAnimationFrame
	const firstCancelAnimationFrame = globalThis.cancelAnimationFrame

	const second = installDomMock()
	const secondSetInterval = globalThis.setInterval
	const secondClearInterval = globalThis.clearInterval
	const secondRequestAnimationFrame = globalThis.requestAnimationFrame
	const secondCancelAnimationFrame = globalThis.cancelAnimationFrame

	first.restore()

	assert.equal(globalThis.document, second.document)
	assert.equal(globalThis.window?.document, second.document)
	assert.equal(globalThis.setInterval, secondSetInterval)
	assert.equal(globalThis.clearInterval, secondClearInterval)
	assert.equal(globalThis.requestAnimationFrame, secondRequestAnimationFrame)
	assert.equal(globalThis.cancelAnimationFrame, secondCancelAnimationFrame)

	second.restore()

	assert.notEqual(globalThis.document, first.document)
	assert.notEqual(globalThis.document, second.document)
	assert.notEqual(globalThis.window?.document, first.document)
	assert.notEqual(globalThis.window?.document, second.document)
	assert.notEqual(globalThis.setInterval, firstSetInterval)
	assert.notEqual(globalThis.setInterval, secondSetInterval)
	assert.notEqual(globalThis.clearInterval, firstClearInterval)
	assert.notEqual(globalThis.clearInterval, secondClearInterval)
	assert.notEqual(globalThis.requestAnimationFrame, firstRequestAnimationFrame)
	assert.notEqual(globalThis.requestAnimationFrame, secondRequestAnimationFrame)
	assert.notEqual(globalThis.cancelAnimationFrame, firstCancelAnimationFrame)
	assert.notEqual(globalThis.cancelAnimationFrame, secondCancelAnimationFrame)
})
