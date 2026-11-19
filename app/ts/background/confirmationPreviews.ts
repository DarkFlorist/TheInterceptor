import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
import type { ConfirmationRunId, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { isExpectedInfrastructureError } from '../utils/errors.js'
import { getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'
import { updatePendingTransactionOrMessage } from './storageVariables.js'

export const isSameConfirmationRun = (first: ConfirmationRunId | undefined, second: ConfirmationRunId | undefined) => first === undefined || second === undefined ? first === second : first.lifetime === second.lifetime && first.sequence === second.sequence

// The previews that confirmations store: which simulation run a stored preview may be replaced by, and refreshing a stored preview's metadata.

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		confirmationRunId?: ConfirmationRunId
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
	if (currentConfirmationRunId !== undefined && nextConfirmationRunId !== undefined) return nextConfirmationRunId.lifetime !== currentConfirmationRunId.lifetime || nextConfirmationRunId.sequence >= currentConfirmationRunId.sequence
	return getSimulationStartedTimestamp(nextPopupVisualisation).getTime() >= getSimulationStartedTimestamp(currentPopupVisualisation).getTime()
}

type ConfirmationVisualisation = { readonly statusCode: 'success' | 'failed', readonly data: { readonly confirmationRunId?: ConfirmationRunId } }

// Each request's latest metadata refresh wins, including overlapping refreshes of the same simulation run. Entries are released once the latest refresh finishes.
const metadataRefreshes = new Map<string, object>()
export function startConfirmationMetadataRefresh(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	const key = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const ticket = {}
	metadataRefreshes.set(key, ticket)
	return {
		isCurrent: () => metadataRefreshes.get(key) === ticket,
		finish: () => { if (metadataRefreshes.get(key) === ticket) metadataRefreshes.delete(key) },
	}
}

// Both single and batch confirmations use one write guard. The flow resolves its metadata, while this boundary preserves newer runs and concurrent approval changes.
export async function refreshConfirmationMetadata<Visualisation extends ConfirmationVisualisation>(
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	refreshedVisualisation: Visualisation,
	refresh: () => Promise<Visualisation | undefined>,
	getShownVisualisation: (current: PendingTransactionOrSignableMessage) => { readonly visualisation: ConfirmationVisualisation, readonly withVisualisation: (visualisation: Visualisation) => PendingTransactionOrSignableMessage } | undefined,
	updateConfirmationWindow: (isCurrent: () => boolean) => Promise<void>,
) {
	const refreshTicket = startConfirmationMetadataRefresh(uniqueRequestIdentifier)
	try {
		const popupVisualisation = await refresh()
		if (popupVisualisation === undefined) return
		let stored = false
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			const shown = getShownVisualisation(current)
			if (shown === undefined || !refreshTicket.isCurrent() || !isSameConfirmationRun(shown.visualisation.data.confirmationRunId, refreshedVisualisation.data.confirmationRunId)) return undefined
			stored = true
			return shown.withVisualisation(popupVisualisation)
		})
		if (stored && refreshTicket.isCurrent()) await updateConfirmationWindow(refreshTicket.isCurrent)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	} finally {
		refreshTicket.finish()
	}
}

// The shared successful-run projection used by single and batch metadata refreshes.
export async function refreshSimulatedConfirmationVisualisation<Data extends { readonly simulationState: SimulationState }>(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined, original: { readonly statusCode: 'success', readonly data: Data }) {
	return { statusCode: 'success' as const, data: { ...original.data, ...await visualizeSimulatorState(original.data.simulationState, ethereum, tokenPriceService, requestAbortController) } }
}
