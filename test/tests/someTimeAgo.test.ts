import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { getSomeTimeAgoText, humanReadableDateDeltaLessDetailed, SomeTimeAgo } from '../../app/ts/components/subcomponents/SomeTimeAgo.js'
import { replaceGlobal } from '../harness/globals.js'
import { installDateMock, installDomMock } from './domMock.js'

describe('SomeTimeAgo', () => {
	test('recomputes the displayed age when the timestamp moves forward', () => {
		const now = new Date('2024-01-01T00:00:10.000Z')
		const formatSeconds = (secondsDiff: number) => `${ Math.round(secondsDiff) }s`
		const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
		const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')
		assert.equal(getSomeTimeAgoText(olderTimestamp, now, false, formatSeconds), '5s')
		assert.equal(getSomeTimeAgoText(newerTimestamp, now, false, formatSeconds), '1s')
	})

	test('rounds multi-day durations using half-day boundaries', () => {
		assert.equal(humanReadableDateDeltaLessDetailed(36.1 * 60 * 60), '2d ago')
		assert.equal(humanReadableDateDeltaLessDetailed(47 * 60 * 60), '2d ago')
	})

	test('updates the rendered output when rerendered with a fresher timestamp', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const formatSeconds = (secondsDiff: number) => `${ Math.round(secondsDiff) }s`
		const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
		const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')

		await act(() => {
			render(h(SomeTimeAgo, { priorTimestamp: olderTimestamp, diffToText: formatSeconds }), dom.document.body)
		})
		assert.equal(dom.document.body.textContent, '5s')

		await act(() => {
			render(h(SomeTimeAgo, { priorTimestamp: newerTimestamp, diffToText: formatSeconds }), dom.document.body)
		})
		assert.equal(dom.document.body.textContent, '1s')

		clock.restore()
		dom.restore()
	})

	test('ticks with the latest formatter and direction, then clears its interval on unmount', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const intervals = new Map<number, () => void>()
		const restoreInterval = replaceGlobal('setInterval', (callback: () => void, delay: number) => {
			assert.equal(delay, 1000)
			intervals.set(1, callback)
			return 1
		})
		const restoreClear = replaceGlobal('clearInterval', (id: number) => { intervals.delete(id) })
		const priorTimestamp = new Date('2024-01-01T00:00:05.000Z')
		try {
			await act(() => { render(h(SomeTimeAgo, { priorTimestamp, diffToText: (seconds) => `${ seconds }s` }), dom.document.body) })
			assert.equal(dom.document.body.textContent, '5s')
			clock.setNow('2024-01-01T00:00:11.000Z')
			await act(() => { for (const tick of intervals.values()) tick() })
			assert.equal(dom.document.body.textContent, '6s')
			await act(() => { render(h(SomeTimeAgo, { priorTimestamp, countBackwards: true, diffToText: (seconds) => `remaining: ${ seconds }` }), dom.document.body) })
			assert.equal(dom.document.body.textContent, 'remaining: -6')
			clock.setNow('2024-01-01T00:00:12.000Z')
			await act(() => { for (const tick of intervals.values()) tick() })
			assert.equal(dom.document.body.textContent, 'remaining: -7')
			await act(() => { render(undefined, dom.document.body) })
			assert.equal(intervals.size, 0)
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			restoreClear()
			restoreInterval()
			clock.restore()
			dom.restore()
		}
	})

})
