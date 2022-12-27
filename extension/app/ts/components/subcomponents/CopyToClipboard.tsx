import { clipboardCopy } from './clipboardcopy.js'

interface CopyToClipboardParams {
	children: preact.VNode
	content: string
	contentDisplayOverride?: string
	copyMessage?: string
}

export function CopyToClipboard(props: CopyToClipboardParams) {
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

interface ToolTipParams {
	children: preact.VNode
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
