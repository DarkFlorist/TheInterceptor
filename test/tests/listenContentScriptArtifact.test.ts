import * as assert from 'assert'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { test } from 'bun:test'

test('bundled content script listener has an undefined completion value', async () => {
	const buildResult = await Bun.build({
		entrypoints: [path.resolve('app/inpage/ts/listenContentScript.ts')],
		target: 'browser',
		format: 'esm',
		splitting: false,
		write: false,
	})
	if (!buildResult.success) throw new Error(buildResult.logs.map((log) => log.message).join('\n'))
	const output = buildResult.outputs[0]
	if (output === undefined) throw new Error('Bundling the content script listener produced no output')

	const context = {}
	const completionValue = vm.runInNewContext(await output.text(), context)

	assert.equal(completionValue, undefined)
	assert.equal(vm.runInNewContext('typeof globalThis[Symbol.for("TheInterceptor.listenContentScript")]', context), 'function')
})
