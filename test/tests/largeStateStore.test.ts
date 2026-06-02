import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { estimateSerializedStateBytes, formatEstimatedBytes } from '../../app/ts/utils/largeStateStore.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'

const stack: InterceptorTransactionStack = {
	operations: [
		{
			type: 'TimeManipulation',
			blockTimeManipulation: {
				type: 'AddToTimestamp',
				deltaToAdd: 11n,
				deltaUnit: 'Seconds',
			},
		},
	],
}

describe('large state store helpers', () => {
	test('estimate serialized bytes for persisted stack state', () => {
		const bytes = estimateSerializedStateBytes(InterceptorTransactionStack, stack)

		assert.equal(typeof bytes, 'number')
		assert.ok(bytes > 0)
	})

	test('format estimated byte sizes into readable units', () => {
		assert.equal(formatEstimatedBytes(512), '512 B')
		assert.equal(formatEstimatedBytes(2048), '2.0 KiB')
		assert.equal(formatEstimatedBytes(2 * 1024 * 1024), '2.00 MiB')
	})
})
