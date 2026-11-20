import type { RichTokenSimulationRefresh } from '../types/interceptor-reply-messages.js'
import type { RichFundingResult, RichToken } from '../types/richMode.js'
import { getErrorMessage, reportUnexpectedError } from '../utils/errors.js'
import type { PopupSimulationRefreshOutcome } from './popupSimulationRefreshQueue.js'

// A rich-funding mutation as the popup sees it: rejected, or saved together with whether the simulation now reflects it.
export type RichFundingOutcome = { readonly ok: true, readonly richToken: RichToken | undefined, readonly simulationRefresh: RichTokenSimulationRefresh } | { readonly ok: false, readonly error: string }

// The funding change is already committed when this runs, so a refresh failure is reported and returned as an outcome instead of being thrown past the popup reply.
export async function refreshSimulationAfterRichFundingChange(refresh: () => Promise<PopupSimulationRefreshOutcome>): Promise<RichTokenSimulationRefresh> {
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

// Completes every rich-funding mutation the same way: a rejection passes through, and a saved change refreshes the simulation only when funding changed. Without a change the current simulation already reflects the saved funding.
export async function completeRichFundingMutation(result: RichFundingResult, refresh: () => Promise<PopupSimulationRefreshOutcome>): Promise<RichFundingOutcome> {
	if (!result.ok) return result
	const simulationRefresh = result.fundingChanged ? await refreshSimulationAfterRichFundingChange(refresh) : 'Refreshed'
	return { ok: true, richToken: result.richToken, simulationRefresh }
}

// The two popup replies for a rich-funding outcome; this is the only place outcomes become replies.
export const toModifyRichTokenReply = (outcome: RichFundingOutcome) => ({
	method: 'popup_modifyRichToken' as const,
	result: outcome.ok ? { success: true as const, richToken: outcome.richToken, simulationRefresh: outcome.simulationRefresh } : { success: false as const, error: outcome.error },
})

export const toRichSettingsChangeReply = (outcome: RichFundingOutcome) => {
	if (!outcome.ok) return { type: 'PopupSettingsChangeReply' as const, ok: false as const, message: outcome.error }
	if (outcome.simulationRefresh === 'Unavailable') return { type: 'PopupSettingsChangeReply' as const, ok: false as const, message: 'The rich setting was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.' }
	return { type: 'PopupSettingsChangeReply' as const, ok: true as const }
}
