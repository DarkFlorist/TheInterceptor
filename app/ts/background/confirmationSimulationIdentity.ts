import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'

type VisualisationData = ConfirmTransactionTransactionSingleVisualization['data']
type TimestampedSimulation = {
	readonly data: Pick<VisualisationData, 'simulationStartedTimestamp'> & {
		readonly simulationState: Pick<VisualisationData['simulationState'], 'simulationConductedTimestamp'>
	}
}

// A later-started run supersedes an earlier run even if the earlier run finishes last. Completion orders results whose start timestamps coincide.
function compareConfirmationSimulations(first: TimestampedSimulation, second: TimestampedSimulation) {
	return first.data.simulationStartedTimestamp.getTime() - second.data.simulationStartedTimestamp.getTime()
		|| first.data.simulationState.simulationConductedTimestamp.getTime() - second.data.simulationState.simulationConductedTimestamp.getTime()
}

export const isSameConfirmationSimulation = (first: TimestampedSimulation, second: TimestampedSimulation) => compareConfirmationSimulations(first, second) === 0

export const shouldReplaceConfirmationSimulation = (current: TimestampedSimulation | undefined, next: TimestampedSimulation) => current === undefined || compareConfirmationSimulations(next, current) >= 0
