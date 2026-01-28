import { ComponentChildren, JSX } from 'preact'
import { clipboardCopy } from './clipboardcopy.js'

type CopySource = { content: string } | { copyFunction: () => Promise<string | undefined> }

type CopyToClipboardProps = CopySource & {
	children: ComponentChildren
	contentDisplayOverride?: string
	copyMessage?: string
	style?: JSX.CSSProperties
	classNames?: string
}

export function CopyToClipboard(props: CopyToClipboardProps) {
	const performCopy = async () => {
		if ('content' in props) {
			await clipboardCopy(props.content)
			return
		}

		const resolvedText = await props.copyFunction()
		if (resolvedText === undefined) return
		await clipboardCopy(resolvedText)
	}

	const tooltipContent = 'content' in props ? (props.contentDisplayOverride ?? props.content) : props.contentDisplayOverride

	return <div onClick = { performCopy } class = { props.classNames } style = { props.style ?? 'display: inherit; overflow: inherit;' }>
		<div data-hint-clickable-hide-timer-ms = { 1500 } data-hint = { props.copyMessage ?? 'Copied to clipboard!' } data-tooltip = { tooltipContent } style = 'display: inherit; overflow: inherit; width: 100%;'>
			{ props.children }
		</div>
	</div>
}

interface ToolTipParams {
	children: ComponentChildren
	content: string
}

export function ToolTip(props: ToolTipParams) {
	return <div style = 'display: inherit; overflow: inherit;'>
		<div data-tooltip = { props.content } style = 'display: inherit; overflow: inherit; width: 100%;'>
			{ props.children }
		</div>
	</div>
}
