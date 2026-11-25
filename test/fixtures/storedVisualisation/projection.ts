import { getPopupVisualisationForDisplay, getStoredPopupVisualisationState, setStoredPopupVisualisationState, updateStoredPopupVisualisation } from '../../../app/ts/background/storageVariables.js'

export async function verifyVisualisationWriteBoundary() {
	const stored = await getStoredPopupVisualisationState()
	await setStoredPopupVisualisationState(stored)
	await updateStoredPopupVisualisation(async () => stored)

	const display = await getPopupVisualisationForDisplay()
	await setStoredPopupVisualisationState(display) // expect-type-error
	await updateStoredPopupVisualisation(async () => display) // expect-type-error
}
