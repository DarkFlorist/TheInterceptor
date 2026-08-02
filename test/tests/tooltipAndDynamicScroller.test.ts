import * as assert from 'assert'
import { signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { getDynamicScrollOffset } from '../../app/ts/components/subcomponents/DynamicScroller.js'
import { scheduleTooltipDismissal, type TooltipConfig } from '../../app/ts/components/subcomponents/Tooltip.js'

describe('tooltip dismissal', () => {
	test('does not let an older timer dismiss newer tooltip content', () => {
		const firstConfig: TooltipConfig = { message: 'first', x: 0, y: 0 }
		const secondConfig: TooltipConfig = { message: 'second', x: 0, y: 0 }
		const config = signal<TooltipConfig | undefined>(firstConfig)
		let scheduledCallback: (() => void) | undefined
		let cancelledTimer: number | undefined
		const cleanup = scheduleTooltipDismissal(
			config,
			firstConfig,
			(callback) => {
				scheduledCallback = callback
				return 7
			},
			(timer) => { cancelledTimer = timer },
		)

		config.value = secondConfig
		scheduledCallback?.()
		assert.equal(config.value, secondConfig)
		cleanup()
		assert.equal(cancelledTimer, 7)
	})

	test('honors an explicit zero duration', () => {
		const activeConfig: TooltipConfig = { message: 'brief', x: 0, y: 0, duration: 0 }
		const config = signal<TooltipConfig | undefined>(activeConfig)
		let scheduledDuration: number | undefined
		scheduleTooltipDismissal(config, activeConfig, (_callback, duration) => {
			scheduledDuration = duration
			return 1
		})
		assert.equal(scheduledDuration, 0)
	})
})

describe('dynamic scrolling offset', () => {
	test('does not translate a short list above the viewport', () => {
		assert.equal(getDynamicScrollOffset(0, 40, 2, 10), 0)
	})

	test('keeps the offset stable before item measurements are available', () => {
		assert.equal(getDynamicScrollOffset(0, 0, 2, Number.POSITIVE_INFINITY), 0)
	})

	test('clamps the requested offset to the final full viewport', () => {
		assert.equal(getDynamicScrollOffset(8, 40, 10, 4), 240)
	})
})
