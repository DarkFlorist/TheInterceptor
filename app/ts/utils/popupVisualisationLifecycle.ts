// Owns what the popup visualisation states the updater stores and publishes mean to views: whether a state's address book entries are current, and which of two states was stored first. The background's popupVisualisationUpdater.ts builds every state that keeps the previous entries with retainPreviousVisualisation, and popup views read states through the predicates below; it lives in utils, like activeStackContext.ts, so both depend on it without popup code importing from background. See docs/popup-simulation-refresh.md.
import type { CompleteVisualizedSimulation, SimulationUpdatingState } from '../types/visualizer-types.js'
import { assertNever } from './typescript.js'

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

// Within one simulation id, the updater stores the retained 'updating' state first and then at most one result: 'done', 'failed', or 'updating' again when the node cannot be reached, which repeats the first state. A new updating state fails typecheck here until its place in the refresh is decided.
function isRefreshResult(simulationUpdatingState: SimulationUpdatingState) {
	switch (simulationUpdatingState) {
		case 'done':
		case 'failed': return true
		case 'updating': return false
		default: return assertNever(simulationUpdatingState)
	}
}

type VisualisationOrder = Pick<CompleteVisualizedSimulation, 'simulationId' | 'simulationUpdatingState'>

// Whether the candidate was stored before the shown state, so showing it would go back in time: simulation ids grow with every refresh, and within one id the updating state comes before the refresh's result.
export function predatesVisualisation(candidate: VisualisationOrder, shown: VisualisationOrder) {
	if (candidate.simulationId !== shown.simulationId) return candidate.simulationId < shown.simulationId
	return !isRefreshResult(candidate.simulationUpdatingState) && isRefreshResult(shown.simulationUpdatingState)
}
