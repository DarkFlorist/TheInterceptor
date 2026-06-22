import { getPopupRefreshGeneration as getPopupRefreshGenerationFromStorage, setPopupRefreshGeneration } from './storageVariables.js'

let popupRefreshGeneration = 0

const persistPopupRefreshGeneration = (value: number) => {
	void setPopupRefreshGeneration(value).catch((error) => {
		console.warn('Could not persist popup refresh generation:')
		console.warn(error)
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
