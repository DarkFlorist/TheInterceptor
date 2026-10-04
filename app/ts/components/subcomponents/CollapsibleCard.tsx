import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { ChevronIcon } from './icons.js'

// A card whose body is hidden until the header is clicked; the body is only rendered while expanded.
export function CollapsibleCard({ title, children }: { title: string, children: ComponentChildren }) {
	const expanded = useSignal<boolean>(false)
	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => { expanded.value = !expanded.value } }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				{ title }
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ expanded.value ? children : <></> }
	</div>
}
