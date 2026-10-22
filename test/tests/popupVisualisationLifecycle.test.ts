import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { hasCurrentAddressBookEntries, predatesVisualisation, retainPreviousVisualisation } from '../../app/ts/background/popupVisualisationLifecycle.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'

const updaterSource = await Bun.file(new URL('../../app/ts/background/popupVisualisationUpdater.ts', import.meta.url)).text()

const previousEntry: AddressBookEntry = { type: 'contact', name: 'Previous Contact', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const finishedState: CompleteVisualizedSimulation = { ...createPassthroughCompleteVisualizedSimulation(4, 'done'), addressBookEntries: [previousEntry] }

describe('popup visualisation lifecycle', () => {
	test('only a finished refresh carries current address book entries', () => {
		assert.equal(hasCurrentAddressBookEntries({ simulationUpdatingState: 'done' }), true)
		assert.equal(hasCurrentAddressBookEntries({ simulationUpdatingState: 'updating' }), false)
		assert.equal(hasCurrentAddressBookEntries({ simulationUpdatingState: 'failed' }), false)
	})

	test('a state retained from the previous visualisation keeps its entries and is not reported current', () => {
		const retainedStates = [
			retainPreviousVisualisation(finishedState, { simulationId: 5, simulationUpdatingState: 'updating' }),
			retainPreviousVisualisation(finishedState, { simulationId: 5, simulationUpdatingState: 'updating', simulationResultState: 'invalid' }),
			retainPreviousVisualisation(finishedState, { simulationId: 5, simulationUpdatingState: 'failed' }),
		]
		assert.deepEqual(retainedStates.map((state) => [state.simulationId, state.simulationUpdatingState, state.simulationResultState]), [[5, 'updating', 'done'], [5, 'updating', 'invalid'], [5, 'failed', 'done']])
		for (const state of retainedStates) {
			assert.deepEqual(state.addressBookEntries, [previousEntry])
			assert.equal(hasCurrentAddressBookEntries(state), false)
		}
	})

	test('a state predates the shown one when its simulation id is lower', () => {
		assert.equal(predatesVisualisation({ simulationId: 3, simulationUpdatingState: 'done' }, { simulationId: 4, simulationUpdatingState: 'updating' }), true)
		assert.equal(predatesVisualisation({ simulationId: 5, simulationUpdatingState: 'updating' }, { simulationId: 4, simulationUpdatingState: 'done' }), false)
	})

	test('within one simulation id the updating state predates the refresh result', () => {
		for (const result of ['done', 'failed'] as const) {
			assert.equal(predatesVisualisation({ simulationId: 4, simulationUpdatingState: 'updating' }, { simulationId: 4, simulationUpdatingState: result }), true)
			assert.equal(predatesVisualisation({ simulationId: 4, simulationUpdatingState: result }, { simulationId: 4, simulationUpdatingState: 'updating' }), false)
			assert.equal(predatesVisualisation({ simulationId: 4, simulationUpdatingState: result }, { simulationId: 4, simulationUpdatingState: result }), false)
		}
		assert.equal(predatesVisualisation({ simulationId: 4, simulationUpdatingState: 'updating' }, { simulationId: 4, simulationUpdatingState: 'updating' }), false)
	})

	test('the updater builds every state derived from the stored visualisation with retainPreviousVisualisation', () => {
		assert.match(updaterSource, /retainPreviousVisualisation\(popupVisualisation, /u)
		assert.doesNotMatch(updaterSource, /\bmodifyObject\(|\.\.\.popupVisualisation\b/u)
	})
})
