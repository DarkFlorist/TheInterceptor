import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { type ShownSimulationStack, type SimulationStackUpdate, applySimulationStackUpdate } from '../../app/ts/components/pages/fetchSimulationStackUpdates.js'
import { retainPreviousVisualisation } from '../../app/ts/utils/popupVisualisationLifecycle.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'

const previousEntry: AddressBookEntry = { type: 'contact', name: 'Previous Contact', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const openingEntry: AddressBookEntry = { type: 'contact', name: 'Opening Contact', address: 0x2222222222222222222222222222222222222222n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const publishedEntry: AddressBookEntry = { type: 'contact', name: 'Published Contact', address: 0x3333333333333333333333333333333333333333n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const nothingShown: ShownSimulationStack = { visualisation: createPassthroughCompleteVisualizedSimulation(), addressBookEntries: undefined }

function createFinishedState(simulationId: number, entry: AddressBookEntry): CompleteVisualizedSimulation {
	return { ...createPassthroughCompleteVisualizedSimulation(simulationId, 'done'), addressBookEntries: [entry] }
}

const applyInOrder = (updates: readonly SimulationStackUpdate[]) => updates.reduce(applySimulationStackUpdate, nothingShown)
const publication = (visualisation: CompleteVisualizedSimulation): SimulationStackUpdate => ({ source: 'publication', visualisation })
const openingVisualisationReply = (visualisation: CompleteVisualizedSimulation): SimulationStackUpdate => ({ source: 'openingVisualisationReply', visualisation })
const openingMetadataReply = (entry: AddressBookEntry): SimulationStackUpdate => ({ source: 'openingMetadataReply', addressBookEntries: [entry] })

describe('applySimulationStackUpdate', () => {
	test('the opening replies alone show the stored stack and the opening address references', () => {
		const storedState = createFinishedState(1, previousEntry)
		for (const updates of [[openingVisualisationReply(storedState), openingMetadataReply(openingEntry)], [openingMetadataReply(openingEntry), openingVisualisationReply(storedState)]]) {
			assert.deepEqual(applyInOrder(updates), { visualisation: storedState, addressBookEntries: [openingEntry] })
		}
	})

	test('an updating or failed publication shows its rows and keeps the last finished address references', () => {
		const finished = createFinishedState(2, publishedEntry)
		for (const simulationUpdatingState of ['updating', 'failed'] as const) {
			const retained = retainPreviousVisualisation(createFinishedState(2, previousEntry), { simulationId: 3, simulationUpdatingState })
			assert.deepEqual(applyInOrder([publication(finished), publication(retained)]), { visualisation: retained, addressBookEntries: [publishedEntry] })
		}
	})

	test('every finished publication replaces the rows and address references', () => {
		const changed = createFinishedState(3, publishedEntry)
		assert.deepEqual(applyInOrder([openingMetadataReply(openingEntry), publication(createFinishedState(2, previousEntry)), publication(changed)]), { visualisation: changed, addressBookEntries: [publishedEntry] })
	})

	test('opening replies that arrive after a finished publication keep its rows and address references in either order', () => {
		const published = createFinishedState(3, publishedEntry)
		const olderStoredState = createFinishedState(2, openingEntry)
		for (const updates of [
			[publication(published), openingVisualisationReply(olderStoredState), openingMetadataReply(openingEntry)],
			[publication(published), openingMetadataReply(openingEntry), openingVisualisationReply(olderStoredState)],
		]) {
			assert.deepEqual(applyInOrder(updates), { visualisation: published, addressBookEntries: [publishedEntry] })
		}
	})

	test('an opening reply with the updating state of a refresh does not replace the published result of that refresh', () => {
		const published = createFinishedState(3, publishedEntry)
		const capturedWhileUpdating = retainPreviousVisualisation(createFinishedState(2, previousEntry), { simulationId: 3, simulationUpdatingState: 'updating' })
		assert.deepEqual(applyInOrder([publication(published), openingVisualisationReply(capturedWhileUpdating)]).visualisation, published)
	})

	test('an opening reply with the result of a refresh replaces the published updating state of that refresh', () => {
		const result = createFinishedState(3, publishedEntry)
		const publishedUpdating = retainPreviousVisualisation(createFinishedState(2, previousEntry), { simulationId: 3, simulationUpdatingState: 'updating' })
		assert.deepEqual(applyInOrder([publication(publishedUpdating), openingVisualisationReply(result)]).visualisation, result)
	})

	test('the opening address references still fill in when only an updating or failed publication arrived first', () => {
		for (const simulationUpdatingState of ['updating', 'failed'] as const) {
			const retained = retainPreviousVisualisation(createPassthroughCompleteVisualizedSimulation(1), { simulationId: 2, simulationUpdatingState })
			assert.deepEqual(applyInOrder([publication(retained), openingMetadataReply(openingEntry)]).addressBookEntries, [openingEntry])
		}
	})

	test('an opening reply from a newer refresh replaces an older published state', () => {
		const newerStoredState = createFinishedState(4, openingEntry)
		assert.deepEqual(applyInOrder([publication(createFinishedState(3, publishedEntry)), openingVisualisationReply(newerStoredState)]).visualisation, newerStoredState)
	})
})
