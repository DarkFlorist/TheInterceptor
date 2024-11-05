import { Signal, useSignalEffect } from '@preact/signals'
import { useRef } from 'preact/hooks'

export type TooltipConfig = {
	message: string
	x: number
	y: number
	duration?: number
}

export function Tooltip({ config }: { config: Signal<TooltipConfig | undefined> }) {
	const popoverRef = useRef<HTMLDivElement>(null)

	useSignalEffect(() => {
		if (!config.value) {
			popoverRef.current?.hidePopover()
			return
		}

		popoverRef.current?.showPopover()
		setTimeout(() => config.value = undefined, config.value.duration || 1500)
	})

	return (
		<div ref = { popoverRef } class='tooltip' popover style = { { left: config.value?.x || 0, top: config.value?.y || 0 } }>
			{ config.value?.message || '' }
		</div>
	)
}
