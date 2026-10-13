import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useEffectWhenValuesChange } from '../../app/ts/utils/preact-utilities.js'
import { installDomMock } from './domMock.js'

type EffectProbeProps = {
	readonly watchedValues: readonly unknown[]
	// Passed to the effect on each render, so a run records which render's closure it used.
	readonly label: string
	readonly runs: string[]
}

function EffectProbe({ watchedValues, label, runs }: EffectProbeProps) {
	useEffectWhenValuesChange(watchedValues, () => { runs.push(label) })
	return <p>{ label }</p>
}

describe('useEffectWhenValuesChange', () => {
	test('runs after the first render and again only when a watched value changes, using the newest effect', async () => {
		const dom = installDomMock()
		const runs: string[] = []
		const rerender = async (watchedValues: readonly unknown[], label: string) => await act(() => {
			render(h(EffectProbe, { watchedValues, label, runs }), dom.document.body)
		})
		try {
			await rerender([1n, 'transaction'], 'first render')
			assert.deepEqual(runs, ['first render'])

			// A new array and a new effect closure with the same entries do not trigger it.
			await rerender([1n, 'transaction'], 'same values')
			assert.deepEqual(runs, ['first render'])

			await rerender([2n, 'transaction'], 'changed value')
			assert.deepEqual(runs, ['first render', 'changed value'])

			await rerender([2n, 'transaction', undefined], 'added value')
			assert.deepEqual(runs, ['first render', 'changed value', 'added value'])
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})

	test('compares entries by identity, so an equal but newly built object counts as a change', async () => {
		const dom = installDomMock()
		const runs: string[] = []
		const watchedObject = { proposalId: 42n }
		const rerender = async (watchedValues: readonly unknown[], label: string) => await act(() => {
			render(h(EffectProbe, { watchedValues, label, runs }), dom.document.body)
		})
		try {
			await rerender([watchedObject, Number.NaN], 'first render')
			await rerender([watchedObject, Number.NaN], 'same object')
			assert.deepEqual(runs, ['first render'])

			await rerender([{ proposalId: 42n }, Number.NaN], 'equal new object')
			assert.deepEqual(runs, ['first render', 'equal new object'])
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})
})
