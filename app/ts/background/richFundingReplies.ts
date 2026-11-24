import { createRichTokenFailureReply } from '../types/richModeRequests.js'
import type { RichFundingResult, RichToken } from '../types/richMode.js'
import { getErrorMessage, reportUnexpectedError } from '../utils/errors.js'
import type { PopupSimulationRefreshOutcome } from './popupSimulationRefreshQueue.js'

// Whether a saved funding change's simulation reflects it: refreshed, superseded by a newer refresh, or unavailable.
export type RichFundingSimulationRefresh = 'Refreshed' | 'Superseded' | 'Unavailable'

// A rich-funding mutation as the background sees it: rejected, or saved together with whether the simulation now reflects it.
export type RichFundingOutcome = { readonly ok: true, readonly richToken: RichToken | undefined, readonly simulationRefresh: RichFundingSimulationRefresh } | { readonly ok: false, readonly error: string }

// The message both rich-funding commands reply with when the change was saved but the latest simulation is unavailable; main's rich setting command established it.
export const SAVED_BUT_SIMULATION_UNAVAILABLE_MESSAGE = 'The rich setting was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.'

// The funding change is already committed when this runs, so a refresh failure is reported and returned as an outcome instead of being thrown past the popup reply.
export async function refreshSimulationAfterRichFundingChange(refresh: () => Promise<PopupSimulationRefreshOutcome>): Promise<RichFundingSimulationRefresh> {
	try {
		const outcome = await refresh()
		// The queue settles a superseded request before its replacement runs, so the replacement's result is unknown here and is not reported as a completed refresh.
		if (outcome.status === 'superseded') return 'Superseded'
		return outcome.available ? 'Refreshed' : 'Unavailable'
	} catch (error: unknown) {
		await reportUnexpectedError(error, {
			displayMessage: `Rich-mode funding was saved, but refreshing the simulation failed: ${ getErrorMessage(error) ?? 'Unknown error' }`,
			code: 'rich_funding_simulation_refresh_failed',
		})
		return 'Unavailable'
	}
}

type RichFundingSimulation = {
	readonly refresh: () => Promise<PopupSimulationRefreshOutcome>
	// Whether the stored popup simulation is available, the same test the refresh queue reports after a refresh.
	readonly isStoredSimulationAvailable: () => Promise<boolean>
}

// Completes every rich-funding mutation the same way: a rejection passes through, and a saved mutation refreshes the simulation unless funding is unchanged and the stored simulation is available. Unchanged funding alone does not prove the simulation reflects it, because an earlier refresh may have failed, so retrying a setting then retries the refresh.
export async function completeRichFundingMutation(result: RichFundingResult, simulation: RichFundingSimulation): Promise<RichFundingOutcome> {
	if (!result.ok) return result
	const simulationIsCurrent = !result.fundingChanged && await simulation.isStoredSimulationAvailable()
	const simulationRefresh = simulationIsCurrent ? 'Refreshed' : await refreshSimulationAfterRichFundingChange(simulation.refresh)
	return { ok: true, richToken: result.richToken, simulationRefresh }
}

// The one reply contract of both rich-funding commands: saved with a current or superseded simulation is a success; rejected, or saved while the simulation is unavailable, is a failure with a message. This is the only place outcomes become replies.
export const toRichFundingReply = (outcome: RichFundingOutcome) => {
	if (!outcome.ok) return { ok: false as const, error: outcome.error }
	if (outcome.simulationRefresh === 'Unavailable') return { ok: false as const, error: SAVED_BUT_SIMULATION_UNAVAILABLE_MESSAGE }
	return { ok: true as const, richToken: outcome.richToken, simulationRefresh: outcome.simulationRefresh }
}

export const toModifyRichTokenReply = (outcome: RichFundingOutcome) => {
	const reply = toRichFundingReply(outcome)
	return reply.ok
		? { method: 'popup_modifyRichToken' as const, result: { success: true as const, richToken: reply.richToken, simulationRefresh: reply.simulationRefresh } }
		: createRichTokenFailureReply(reply.error)
}

export const toRichSettingsChangeReply = (outcome: RichFundingOutcome) => {
	const reply = toRichFundingReply(outcome)
	return reply.ok ? { type: 'PopupSettingsChangeReply' as const, ok: true as const } : { type: 'PopupSettingsChangeReply' as const, ok: false as const, message: reply.error }
}
