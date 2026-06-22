import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'

const RESET_BUTTON_RECOVERY_DELAY_MS = 4000

export function useResetSimulation(resetButtonRecoveryDelayMs = RESET_BUTTON_RECOVERY_DELAY_MS) {
	const disableReset = useSignal<boolean>(false)
	const resetRecoveryTimeoutId = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

	function clearResetRecoveryTimeout() {
		if (resetRecoveryTimeoutId.current === undefined) return
		globalThis.clearTimeout(resetRecoveryTimeoutId.current)
		resetRecoveryTimeoutId.current = undefined
	}

	function markSimulationDataReceived() {
		clearResetRecoveryTimeout()
		disableReset.value = false
	}

	useEffect(() => () => clearResetRecoveryTimeout(), [])

	function resetSimulation() {
		disableReset.value = true
		clearResetRecoveryTimeout()
		resetRecoveryTimeoutId.current = globalThis.setTimeout(() => {
			resetRecoveryTimeoutId.current = undefined
			disableReset.value = false
		}, resetButtonRecoveryDelayMs)
		void sendPopupMessageToBackgroundPage({ method: 'popup_resetSimulation' })
	}

	return { disableReset, resetSimulation, markSimulationDataReceived }
}
