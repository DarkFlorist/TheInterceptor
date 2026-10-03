import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { ChevronIcon } from './icons.js'

// A card whose body is hidden until the header is clicked; the body is only rendered while expanded.
export function CollapsibleCard({ title, children }: { title: string, children: ComponentChildren }) {
	const expanded = useSignal<boolean>(false)
	return <div class = 'card collapsible-card'>
		<header class = 'card-header noselect collapsible-card-header' onClick = { () => { expanded.value = !expanded.value } }>
			<p class = 'card-header-title collapsible-card-title'>
				{ title }
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ expanded.value ? children : <></> }
	</div>
}
