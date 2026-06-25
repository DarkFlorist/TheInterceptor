import { getPopupRefreshGeneration as getPopupRefreshGenerationFromStorage, setPopupRefreshGeneration } from './storageVariables.js'
import { reportLocalRecoveryAtAsyncBoundary } from '../utils/errors.js'

let popupRefreshGeneration = 0

const persistPopupRefreshGeneration = (value: number) => {
	reportLocalRecoveryAtAsyncBoundary(async () => {
		await setPopupRefreshGeneration(value)
	}, {
		code: 'popup_refresh_generation_persist_failed',
		message: 'Continuing with the in-memory popup refresh generation.',
		details: { popupRefreshGeneration: value },
	})
}

export const initializePopupRefreshGeneration = async () => {
	const storedGeneration = await getPopupRefreshGenerationFromStorage()
	popupRefreshGeneration = Math.max(storedGeneration ?? 0, Date.now())
	persistPopupRefreshGeneration(popupRefreshGeneration)
	return popupRefreshGeneration
}

export const bumpPopupRefreshGeneration = () => {
	popupRefreshGeneration = Math.max(popupRefreshGeneration + 1, Date.now())
	persistPopupRefreshGeneration(popupRefreshGeneration)
	return popupRefreshGeneration
}
export const getPopupRefreshGeneration = () => popupRefreshGeneration
