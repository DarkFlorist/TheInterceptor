import * as assert from 'node:assert'
import { signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { getClampedDynamicScrollStartIndex, getDynamicScrollOffset } from '../../app/ts/components/subcomponents/DynamicScroller.js'
import { clearHintTimeouts } from '../../app/ts/components/subcomponents/Hint.js'
import { scheduleTooltipDismissal, type TooltipConfig } from '../../app/ts/components/subcomponents/Tooltip.js'

// Fake schedulers must return the platform timer handle type, so they hand out real timers that are cleared straight away and only compared by identity.
const createInertTimerHandle = () => {
	const timerHandle = setTimeout(() => undefined, 0)
	clearTimeout(timerHandle)
	return timerHandle
}

describe('tooltip dismissal', () => {
	test('does not let an older timer dismiss newer tooltip content', () => {
		const firstConfig: TooltipConfig = { message: 'first', x: 0, y: 0 }
		const secondConfig: TooltipConfig = { message: 'second', x: 0, y: 0 }
		const config = signal<TooltipConfig | undefined>(firstConfig)
		const dismissalTimer = createInertTimerHandle()
		let scheduledCallback: (() => void) | undefined
		let cancelledTimer: ReturnType<typeof setTimeout> | undefined
		const cleanup = scheduleTooltipDismissal(
			config,
			firstConfig,
			(callback) => {
				scheduledCallback = callback
				return dismissalTimer
			},
			(timer) => { cancelledTimer = timer },
		)

		config.value = secondConfig
		scheduledCallback?.()
		assert.equal(config.value, secondConfig)
		cleanup()
		assert.equal(cancelledTimer, dismissalTimer)
	})

	test('honors an explicit zero duration', () => {
		const activeConfig: TooltipConfig = { message: 'brief', x: 0, y: 0, duration: 0 }
		const config = signal<TooltipConfig | undefined>(activeConfig)
		let scheduledDuration: number | undefined
		scheduleTooltipDismissal(config, activeConfig, (_callback, duration) => {
			scheduledDuration = duration
			return createInertTimerHandle()
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

	test('clamps a stale start index when the item list shrinks', () => {
		assert.equal(getClampedDynamicScrollStartIndex(8, 2, 4), 0)
		assert.equal(getClampedDynamicScrollStartIndex(8, 10, 4), 6)
	})
})

describe('hint cleanup', () => {
	test('clears both pending hint timers on cleanup', () => {
		const copyMessageTimer = createInertTimerHandle()
		const tooltipTimer = createInertTimerHandle()
		const clearedTimers: unknown[] = []
		clearHintTimeouts([copyMessageTimer, tooltipTimer], (timerId) => { clearedTimers.push(timerId) })
		assert.equal(clearedTimers.length, 2)
		assert.equal(clearedTimers[0], copyMessageTimer)
		assert.equal(clearedTimers[1], tooltipTimer)
	})
})
