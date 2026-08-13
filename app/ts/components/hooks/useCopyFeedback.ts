import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { TooltipConfig } from '../subcomponents/Tooltip.js'

export const COPY_FEEDBACK_DURATION_MS = 4000

export function useCopyFeedback(message = 'Copied!') {
	const coolingDown = useSignal(false)
	const tooltip = useSignal<TooltipConfig | undefined>(undefined)
	const cooldownTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

	useEffect(() => () => {
		if (cooldownTimer.current !== undefined) globalThis.clearTimeout(cooldownTimer.current)
	}, [])

	const showCopied = ({ x, y }: { x: number, y: number }) => {
		if (cooldownTimer.current !== undefined) globalThis.clearTimeout(cooldownTimer.current)
		coolingDown.value = true
		tooltip.value = { message, x, y, duration: COPY_FEEDBACK_DURATION_MS }
		cooldownTimer.current = globalThis.setTimeout(() => {
			coolingDown.value = false
			cooldownTimer.current = undefined
		}, COPY_FEEDBACK_DURATION_MS)
	}

	return { coolingDown, tooltip, showCopied }
}
