import { sendPopupMessageToOpenWindows } from '../../../app/ts/background/backgroundUtils.js'
import { getPopupVisualisationForDisplay, getStoredPopupVisualisationState, setStoredPopupVisualisationState, updateStoredPopupVisualisation } from '../../../app/ts/background/storageVariables.js'

export async function verifyVisualisationWriteBoundary() {
	const stored = await getStoredPopupVisualisationState()
	await setStoredPopupVisualisationState(stored)
	await updateStoredPopupVisualisation(async () => stored)

	await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: stored } }) // expect-type-error

	const display = await getPopupVisualisationForDisplay()
	await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: display } })
	await setStoredPopupVisualisationState(display) // expect-type-error
	await updateStoredPopupVisualisation(async () => display) // expect-type-error
}
