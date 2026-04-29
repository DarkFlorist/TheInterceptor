import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { estimateSerializedStateBytes, formatEstimatedBytes } from '../../app/ts/utils/largeStateStore.js'
import { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'

const stack: InterceptorTransactionStack = {
	operations: [{
		type: 'TimeManipulation',
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 11n, deltaUnit: 'Seconds' },
	}],
}

export async function main() {
	describe('large state store helpers', () => {
		should('estimate serialized bytes for persisted stack state', () => {
			const bytes = estimateSerializedStateBytes(InterceptorTransactionStack, stack)

			assert.equal(typeof bytes, 'number')
			assert.ok(bytes > 0)
		})

		should('format estimated byte sizes into readable units', () => {
			assert.equal(formatEstimatedBytes(512), '512 B')
			assert.equal(formatEstimatedBytes(2048), '2.0 KiB')
			assert.equal(formatEstimatedBytes(2 * 1024 * 1024), '2.00 MiB')
		})
	})

	await runIfRoot(run, import.meta)
}
