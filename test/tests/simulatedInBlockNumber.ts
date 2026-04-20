import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Signal } from '@preact/signals'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { SimulatedInBlockNumber, getSimulationDisplayBlockNumber, getSimulationFreshnessColor } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import { installDomMock } from './someTimeAgo.js'

async function main() {
	describe('SimulatedInBlockNumber', () => {
		should('derives the displayed block number from the simulated block count', () => {
			assert.equal(getSimulationDisplayBlockNumber(123n, 0), 123n)
			assert.equal(getSimulationDisplayBlockNumber(123n, 1), 124n)
			assert.equal(getSimulationDisplayBlockNumber(123n, 3), 126n)
		})

		should('treats the next block simulation as fresh', () => {
			assert.equal(getSimulationFreshnessColor(124n, 123n, undefined), 'var(--positive-color)')
			assert.equal(getSimulationFreshnessColor(124n, 124n, undefined), 'var(--positive-color)')
			assert.equal(getSimulationFreshnessColor(124n, 125n, undefined), 'var(--warning-color)')
			assert.equal(getSimulationFreshnessColor(124n, 126n, undefined), 'var(--negative-color)')
		})

		should('updates the rendered age when the simulation timestamp changes', async () => {
			const dom = installDomMock()
			const currentBlockNumber = new Signal<bigint | undefined>(123n)
			const rpcConnectionStatus = new Signal(undefined)
			const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
			const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')

			await act(() => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(SimulatedInBlockNumber, { simulationBlockNumber: 123n, currentBlockNumber, simulationConductedTimestamp: olderTimestamp, rpcConnectionStatus }), dom.document.body)
			})
			assert.equal(dom.document.body.textContent?.includes('Simulated 5s ago'), true)

			await act(() => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(SimulatedInBlockNumber, { simulationBlockNumber: 123n, currentBlockNumber, simulationConductedTimestamp: newerTimestamp, rpcConnectionStatus }), dom.document.body)
			})
			assert.equal(dom.document.body.textContent?.includes('Simulated 1s ago'), true)

			dom.restore()
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
