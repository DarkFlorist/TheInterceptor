// Owns whether a published popup visualisation's address book entries were resolved for the stack it describes. popupVisualisationUpdater.ts builds every state that keeps the previous entries with retainPreviousVisualisation, and views ask hasCurrentAddressBookEntries; this module imports no background services, so popup pages can use it. See docs/popup-simulation-refresh.md.
import type { CompleteVisualizedSimulation, SimulationUpdatingState } from '../types/visualizer-types.js'
import { assertNever } from '../utils/typescript.js'

type RetainedVisualisationChange = {
	readonly simulationId: number
	readonly simulationUpdatingState: Exclude<SimulationUpdatingState, 'done'>
	readonly simulationResultState?: 'invalid'
}

// The state published while a refresh runs, while it cannot reach the node, or after it fails: the previous visualisation under a new simulation id, so its address book entries may predate the current stack. It is never 'done', which hasCurrentAddressBookEntries relies on.
export function retainPreviousVisualisation(previous: CompleteVisualizedSimulation, { simulationId, simulationUpdatingState, simulationResultState }: RetainedVisualisationChange): CompleteVisualizedSimulation {
	return { ...previous, simulationId, simulationUpdatingState, simulationResultState: simulationResultState ?? previous.simulationResultState }
}

// A finished refresh carries the entries it resolved for its stack, or none for a passthrough, empty or other-chain stack. Updating and failed states carry retained entries or, after a failed provider preparation, none, so views keep the entries of the last finished state. A new updating state fails typecheck here until it is decided.
export function hasCurrentAddressBookEntries({ simulationUpdatingState }: Pick<CompleteVisualizedSimulation, 'simulationUpdatingState'>) {
	switch (simulationUpdatingState) {
		case 'done': return true
		case 'updating':
		case 'failed': return false
		default: return assertNever(simulationUpdatingState)
	}
}
