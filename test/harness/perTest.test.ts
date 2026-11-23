import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller, createPerTestRestorer } from './perTest.js'
import { replaceGlobal } from './globals.js'

// The tests in each describe run in order: the first one installs replacements, the second one checks that the afterEach hook undid them.
describe('per-test restorer', () => {
	const { restoreAfterTest } = createPerTestRestorer()
	const restoreOrder: string[] = []

	test('registers restores for the current test', () => {
		restoreAfterTest(() => { restoreOrder.push('first') })
		restoreAfterTest(() => { restoreOrder.push('second') })
		assert.deepEqual(restoreOrder, [])
	})

	test('runs them after that test, newest first, exactly once', () => {
		assert.deepEqual(restoreOrder, ['second', 'first'])
	})
})

describe('per-test browser mock installer', () => {
	const installBrowserMock = createPerTestBrowserMockInstaller()
	const browserBeforeInstall = Reflect.get(globalThis, 'browser')

	test('installs a browser mock for the current test', () => {
		const browserMock = installBrowserMock()
		assert.equal(Reflect.get(globalThis, 'browser'), browserMock.browser)
	})

	test('restores the previous browser global after that test', () => {
		assert.equal(Reflect.get(globalThis, 'browser'), browserBeforeInstall)
	})
})

describe('per-test custom installer', () => {
	const { installForTest } = createPerTestRestorer()
	const originalValue = Reflect.get(globalThis, 'customInstallerValue')
	const installValue = installForTest((value: string) => ({ value, restore: replaceGlobal('customInstallerValue', value) }))

	test('forwards arguments and restores stacked custom installs', () => {
		assert.equal(installValue('first').value, 'first')
		installValue('second')
		assert.equal(Reflect.get(globalThis, 'customInstallerValue'), 'second')
	})

	test('restores the value from before those installs', () => {
		assert.equal(Reflect.get(globalThis, 'customInstallerValue'), originalValue)
	})
})
