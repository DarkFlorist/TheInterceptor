import { ComponentChildren, JSX } from 'preact'
import { clipboardCopy } from './clipboardcopy.js'

interface CopyToClipboardParams {
	children: ComponentChildren
	content: string
	contentDisplayOverride?: string
	copyMessage?: string
	style?: JSX.CSSProperties
}

export function CopyToClipboard(props: CopyToClipboardParams) {
	return (
		<div onClick = { () => { clipboardCopy(props.content) } } style = { 'style' in props ? props.style : 'display: inherit; overflow: inherit;' }>
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

interface ToolTipParams {
	children: ComponentChildren
	content: string
}

export function ToolTip(props: ToolTipParams) {
	return (
		<div style = 'display: inherit; overflow: inherit;'>
			<div
				data-tooltip = { props.content }
				style = 'display: inherit; overflow: inherit; width: 100%;'
			>
				{ props.children }
			</div>
		</div>
	)
}
