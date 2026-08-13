import { type Signal, useSignalEffect } from '@preact/signals'
import { useRef } from 'preact/hooks'

export type TooltipConfig = {
	message: string
	x: number
	y: number
	duration?: number
}

type TooltipTimer = ReturnType<typeof globalThis.setTimeout>

export function scheduleTooltipDismissal(
	config: Signal<TooltipConfig | undefined>,
	activeConfig: TooltipConfig,
	schedule: (callback: () => void, duration: number) => TooltipTimer = globalThis.setTimeout,
	cancel: (timer: TooltipTimer) => void = globalThis.clearTimeout,
) {
	const timer = schedule(() => {
		if (config.peek() === activeConfig) config.value = undefined
	}, activeConfig.duration ?? 1500)
	return () => cancel(timer)
}

export function Tooltip({ config }: { config: Signal<TooltipConfig | undefined> }) {
	const popoverRef = useRef<HTMLDivElement>(null)

	useSignalEffect(() => {
		const activeConfig = config.value
		if (activeConfig === undefined) {
			popoverRef.current?.hidePopover()
			return
		}

		popoverRef.current?.showPopover()
		return scheduleTooltipDismissal(config, activeConfig)
	})

	return (
		<div ref = { popoverRef } class='tooltip' popover style = { { left: config.value?.x || 0, top: config.value?.y || 0 } }>
			{ config.value?.message || '' }
		</div>
	)
}
