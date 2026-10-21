import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { isExpectedInfrastructureError } from '../utils/errors.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
import { updatePendingTransactionOrMessage } from './storageVariables.js'

// The previews that confirmations store: which simulation run a stored preview may be replaced by, and refreshing a stored preview's metadata.

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		confirmationRunId?: number
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationStartedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationStartedTimestamp

// A stored simulation run is only replaced by the same or a newer run, whether either run succeeded or failed. Stored start timestamps keep only whole seconds, so runs are ordered by confirmationRunId when both have one, and by start time only when a run was stored by an older version without an id.
export const shouldReplacePopupVisualisation = (
	currentPopupVisualisation: TimestampedPopupVisualisation | undefined,
	nextPopupVisualisation: TimestampedPopupVisualisation,
) => {
	if (currentPopupVisualisation === undefined) return true
	const currentConfirmationRunId = currentPopupVisualisation.data.confirmationRunId
	const nextConfirmationRunId = nextPopupVisualisation.data.confirmationRunId
	if (currentConfirmationRunId !== undefined && nextConfirmationRunId !== undefined) return nextConfirmationRunId >= currentConfirmationRunId
	return getSimulationStartedTimestamp(nextPopupVisualisation).getTime() >= getSimulationStartedTimestamp(currentPopupVisualisation).getTime()
}

// A visualisation stored without a confirmationRunId by an older version cannot be told apart from a newer run, so it never matches.
const isSameConfirmationSimulation = (current: { readonly data: { readonly confirmationRunId?: number } }, refreshed: { readonly data: { readonly confirmationRunId?: number } }) => current.data.confirmationRunId !== undefined && current.data.confirmationRunId === refreshed.data.confirmationRunId

type SimulatedConfirmationVisualisation<Data> = { readonly statusCode: 'success', readonly data: Data }

// The simulated visualisation that a stored confirmation shows, and the confirmation with a refreshed visualisation in its place.
export type ShownConfirmationVisualisation<Data> = {
	readonly visualisation: { readonly data: { readonly confirmationRunId?: number } }
	readonly withVisualisation: (popupVisualisation: SimulatedConfirmationVisualisation<Data>) => PendingTransactionOrSignableMessage
}

// Re-visualizes a confirmation's simulation with fresh metadata, then updates the confirmation window. The stored confirmation is re-read so that only its visualisation is replaced, and only while it still shows the same simulation run: approval changes made meanwhile and newer simulations are kept. An unreachable RPC leaves everything for the next refresh.
export async function refreshConfirmationMetadata<Data extends { readonly simulationState: SimulationState, readonly confirmationRunId?: number }>(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	requestAbortController: AbortController | undefined,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	refreshedVisualisation: SimulatedConfirmationVisualisation<Data>,
	getShownVisualisation: (current: PendingTransactionOrSignableMessage) => ShownConfirmationVisualisation<Data> | undefined,
	updateConfirmationWindow: () => Promise<void>,
) {
	try {
		const visualizedSimulationState = await visualizeSimulatorState(refreshedVisualisation.data.simulationState, ethereum, tokenPriceService, requestAbortController)
		const popupVisualisation = { statusCode: 'success' as const, data: { ...refreshedVisualisation.data, ...visualizedSimulationState } }
		let stored = false
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			const shown = getShownVisualisation(current)
			if (shown === undefined || !isSameConfirmationSimulation(shown.visualisation, refreshedVisualisation)) return undefined
			stored = true
			return shown.withVisualisation(popupVisualisation)
		})
		if (!stored) return
		await updateConfirmationWindow()
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
}
