import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { calculateMaxVisibleItems } from '../../app/ts/components/subcomponents/DynamicScroller.js'

describe('dynamic scroller measurements', () => {
	test('ignores hidden and invalid measurements', () => {
		assert.equal(calculateMaxVisibleItems(0, 0), 0)
		assert.equal(calculateMaxVisibleItems(600, 0), 0)
		assert.equal(calculateMaxVisibleItems(0, 60), 0)
		assert.equal(calculateMaxVisibleItems(Number.POSITIVE_INFINITY, 60), 0)
		assert.equal(calculateMaxVisibleItems(600, Number.NaN), 0)
	})

	test('calculates a finite viewport after hidden content becomes measurable', () => {
		assert.equal(calculateMaxVisibleItems(600, 60), 10)
		assert.equal(calculateMaxVisibleItems(601, 60), 11)
	})
})
