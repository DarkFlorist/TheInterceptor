import { clipboardCopy } from './clipboardcopy.js'

interface Props {
	children: preact.VNode
	content: string
	contentDisplayOverride?: string
	copyMessage: string | undefined
}

export function CopyToClipboard(props: Props): preact.VNode {
	return (
		<div onClick = { () => { clipboardCopy(props.content) } } style = 'display: inline'>
			<div
				data-hint-clickable-hide-timer-ms = { 1500 }
				data-hint = { props.copyMessage ? props.copyMessage : 'Copied to clipboard!' }
				data-tooltip = { props.contentDisplayOverride ? props.contentDisplayOverride : props.content }
				style = 'display: inline'
			>
				{ props.children }
			</div>
		</div>
	)
}
