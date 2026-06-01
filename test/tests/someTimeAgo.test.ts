import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import {
	getSomeTimeAgoText,
	SomeTimeAgo,
} from '../../app/ts/components/subcomponents/SomeTimeAgo.js'
import { installDateMock, installDomMock } from './domMock.js'

describe('SomeTimeAgo', () => {
	test('recomputes the displayed age when the timestamp moves forward', () => {
		const now = new Date('2024-01-01T00:00:10.000Z')
		const formatSeconds = (secondsDiff: number) => `${Math.round(secondsDiff)}s`
		const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
		const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')
		assert.equal(
			getSomeTimeAgoText(olderTimestamp, now, false, formatSeconds),
			'5s',
		)
		assert.equal(
			getSomeTimeAgoText(newerTimestamp, now, false, formatSeconds),
			'1s',
		)
	})

	test('updates the rendered output when rerendered with a fresher timestamp', async () => {
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const formatSeconds = (secondsDiff: number) => `${Math.round(secondsDiff)}s`
		const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
		const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')

		await act(() => {
			render(
				h(SomeTimeAgo, {
					priorTimestamp: olderTimestamp,
					diffToText: formatSeconds,
				}),
				dom.document.body,
			)
		})
		assert.equal(dom.document.body.textContent, '5s')

		await act(() => {
			render(
				h(SomeTimeAgo, {
					priorTimestamp: newerTimestamp,
					diffToText: formatSeconds,
				}),
				dom.document.body,
			)
		})
		assert.equal(dom.document.body.textContent, '1s')

		clock.restore()
		dom.restore()
	})
})
