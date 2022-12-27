import { ComponentChildren } from 'preact'
import { clipboardCopy } from './clipboardcopy.js'

interface Props {
	children: ComponentChildren
	content: string
	contentDisplayOverride?: string
	copyMessage: string | undefined
}

export function CopyToClipboard(props: Props) {
	return (
		<div onClick = { () => { clipboardCopy(props.content) } } style = 'display: inherit; overflow: inherit;'>
			<div
				data-hint-clickable-hide-timer-ms = { 1500 }
				data-hint = { props.copyMessage ? props.copyMessage : 'Copied to clipboard!' }
				data-tooltip = { props.contentDisplayOverride ? props.contentDisplayOverride : props.content }
				style = 'display: inherit; overflow: inherit; width: 100%;'
			>
				{ props.children }
			</div>
		</div>
	)
}
