import type { ComponentChildren, JSX } from 'preact'
import type { Signal } from '@preact/signals'
import { clipboardCopy } from './clipboardcopy.js'
import { showHint } from './Hint.js'

type CopySource = { content: string } | { copyFunction: () => Promise<string | undefined> }

export const copyToClipboard = async (source: CopySource, copy = clipboardCopy) => {
	if ('content' in source) {
		await copy(source.content)
		return true
	}

	const resolvedText = await source.copyFunction()
	if (resolvedText === undefined) return false
	await copy(resolvedText)
	return true
}

type CopyToClipboardProps = CopySource & {
	children: ComponentChildren
	contentDisplayOverride?: string
	copyMessage?: string
	style?: JSX.CSSProperties
	classNames?: string
}

export function CopyToClipboard(props: CopyToClipboardProps) {
	const performCopy = async (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
		const target = event.currentTarget
		const position = { x: event.clientX, y: event.clientY }
		const text = 'content' in props ? props.content : await props.copyFunction()
		if (text === undefined) return
		try {
			await clipboardCopy(text)
		} catch (error: unknown) {
			if (!(error instanceof DOMException)) throw error
			showHint(target, { content: 'Could not copy to clipboard.', delay: 1500, ...position })
			return
		}
		showHint(target, { content: props.copyMessage ?? 'Copied to clipboard!', delay: 1500, ...position })
	}

	const tooltipContent = 'content' in props ? (props.contentDisplayOverride ?? props.content) : props.contentDisplayOverride

	return <div onClick = { performCopy } class = { props.classNames } style = { props.style ?? 'display: inherit; overflow: inherit;' }>
		<div data-tooltip = { tooltipContent } style = 'display: inherit; overflow: inherit; width: 100%;'>
			{ props.children }
		</div>
	</div>
}

interface ToolTipParams {
	children: ComponentChildren
	content: Signal<string>
}

export function ToolTip(props: ToolTipParams) {
	return <div style = 'display: inherit; overflow: inherit;'>
		<div data-tooltip = { props.content.value } style = 'display: inherit; overflow: inherit; width: 100%;'>
			{ props.children }
		</div>
	</div>
}
