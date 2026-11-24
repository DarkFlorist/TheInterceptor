import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'

const RESET_BUTTON_RECOVERY_DELAY_MS = 4000

type ResetRecoveryTimeoutId = { current: ReturnType<typeof globalThis.setTimeout> | undefined }

function clearResetRecoveryTimeout(resetRecoveryTimeoutId: ResetRecoveryTimeoutId) {
	if (resetRecoveryTimeoutId.current === undefined) return
	globalThis.clearTimeout(resetRecoveryTimeoutId.current)
	resetRecoveryTimeoutId.current = undefined
}

export function useResetSimulation(resetButtonRecoveryDelayMs = RESET_BUTTON_RECOVERY_DELAY_MS) {
	const disableReset = useSignal<boolean>(false)
	const resetRecoveryTimeoutId = useRef<ResetRecoveryTimeoutId['current']>(undefined)

	function markSimulationDataReceived() {
		clearResetRecoveryTimeout(resetRecoveryTimeoutId)
		disableReset.value = false
	}

	useEffect(() => () => clearResetRecoveryTimeout(resetRecoveryTimeoutId), [])

	async function resetSimulation() {
		disableReset.value = true
		clearResetRecoveryTimeout(resetRecoveryTimeoutId)
		resetRecoveryTimeoutId.current = globalThis.setTimeout(() => {
			resetRecoveryTimeoutId.current = undefined
			disableReset.value = false
		}, resetButtonRecoveryDelayMs)
		await sendPopupMessageToBackgroundPage({ method: 'popup_resetSimulation' })
	}

	return { disableReset, resetSimulation, markSimulationDataReceived }
}
