import * as assert from 'node:assert'
import { test } from 'bun:test'
import { isSameConfirmationSimulation, shouldReplaceConfirmationSimulation } from '../../app/ts/background/confirmationSimulationIdentity.js'

const simulation = (started: number, conducted: number) => ({ data: { simulationStartedTimestamp: new Date(started), simulationState: { simulationConductedTimestamp: new Date(conducted) } } })

test('simulation identity includes start and completion values rather than Date object references', () => {
	assert.equal(isSameConfirmationSimulation(simulation(10, 20), simulation(10, 20)), true)
	assert.equal(isSameConfirmationSimulation(simulation(10, 20), simulation(11, 20)), false)
	assert.equal(isSameConfirmationSimulation(simulation(10, 20), simulation(10, 21)), false)
})

test('a late result from an earlier-started run cannot replace the current run', () => {
	assert.equal(shouldReplaceConfirmationSimulation(simulation(20, 30), simulation(10, 40)), false)
	assert.equal(shouldReplaceConfirmationSimulation(simulation(10, 40), simulation(20, 30)), true)
})

test('completion breaks ties between simulations that started at the same timestamp', () => {
	assert.equal(shouldReplaceConfirmationSimulation(simulation(10, 30), simulation(10, 20)), false)
	assert.equal(shouldReplaceConfirmationSimulation(simulation(10, 20), simulation(10, 30)), true)
	assert.equal(shouldReplaceConfirmationSimulation(simulation(10, 20), simulation(10, 20)), true)
	assert.equal(shouldReplaceConfirmationSimulation(undefined, simulation(10, 20)), true)
})
