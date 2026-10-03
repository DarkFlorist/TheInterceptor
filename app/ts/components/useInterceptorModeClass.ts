import { useEffect } from 'preact/hooks'
import { getSettings } from '../background/settings.js'
import { useAsyncState } from '../utils/preact-utilities.js'
import { getInterceptorModeClass } from './ui-utils.js'

// For request windows whose request does not carry the mode it was made in: reads the mode from the stored settings when the window opens. Until the settings have loaded, or if they cannot be read, the window keeps the default palette.
export function useInterceptorModeClass() {
	const { value: simulationMode, waitFor: waitForSimulationMode } = useAsyncState<boolean>()
	useEffect(() => { waitForSimulationMode(async () => (await getSettings()).simulationMode) }, [])
	return simulationMode.value.state === 'resolved' ? getInterceptorModeClass(simulationMode.value.value) : undefined
}
