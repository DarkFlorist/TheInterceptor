import * as assert from 'node:assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { GasLimitEditor } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import { installDomMock } from './domMock.js'
import { getElement, getPreactEventHandler } from './domQueries.js'

test('an estimate matching a typed gas limit does not make the draft unedited', async () => {
	const dom = installDomMock()
	const showEstimate = async (gasLimit: bigint, transactionIdentifier = 1n) => await act(() => {
		render(h(GasLimitEditor, { transactionIdentifier, initialGasLimit: gasLimit, isRawTransaction: false }), dom.document.body)
	})
	const input = () => getElement(dom.document.body, (element) => element.tagName === 'INPUT', 'gas limit input')
	try {
		await showEstimate(21_000n)
		await act(() => {
			input().value = '50000'
			getPreactEventHandler(input(), 'Input')({ currentTarget: input() })
		})
		await showEstimate(50_000n)
		await showEstimate(60_000n)
		assert.equal(input().value, '50000')

		await showEstimate(21_000n, 2n)
		assert.equal(input().value, '21000', 'another transaction starts from its own limit')
		await showEstimate(30_000n, 2n)
		assert.equal(input().value, '30000', 'an unedited draft follows estimates')
	} finally {
		await act(() => render(undefined, dom.document.body))
		dom.restore()
	}
})
