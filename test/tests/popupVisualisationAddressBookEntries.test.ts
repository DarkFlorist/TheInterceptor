import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { hasCurrentAddressBookEntries, retainPreviousVisualisation } from '../../app/ts/background/popupVisualisationAddressBookEntries.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'

const updaterSource = await Bun.file(new URL('../../app/ts/background/popupVisualisationUpdater.ts', import.meta.url)).text()

const previousEntry: AddressBookEntry = { type: 'contact', name: 'Previous Contact', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const finishedState: CompleteVisualizedSimulation = { ...createPassthroughCompleteVisualizedSimulation(4, 'done'), addressBookEntries: [previousEntry] }

describe('popup visualisation address book entries', () => {
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

	test('the updater builds every state derived from the stored visualisation with retainPreviousVisualisation', () => {
		assert.match(updaterSource, /retainPreviousVisualisation\(popupVisualisation, /u)
		assert.doesNotMatch(updaterSource, /\bmodifyObject\(|\.\.\.popupVisualisation\b/u)
	})
})
