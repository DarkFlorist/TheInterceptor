import type { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { clipboardCopy } from './clipboardcopy.js'
import { CopyIcon, EditIcon } from './icons.js'
import { Tooltip, type TooltipConfig } from './Tooltip.js'

type InlineCardProps = {
	icon: () => JSX.Element
	label: string
	copyValue?: string
	noCopy?: boolean
	style?: JSX.CSSProperties
	onEditClicked?: JSX.MouseEventHandler<HTMLButtonElement>
	statusMessageDuration?: number
	warningMessage?: string
	noExpandButtons?: boolean
	nonInteractive?: boolean
	copyOnActionOnly?: boolean
}

export const InlineCard = (props: InlineCardProps) => {
	const tooltip = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation()
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value || props.label)
		tooltip.value = { message: 'Copied!', x: event.clientX, y: event.clientY, duration: props.statusMessageDuration || 1500 }
	}
	const edit = (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation()
		props.onEditClicked?.(event)
	}

	const Icon = props.icon
	const hasAction = !props.noCopy || props.onEditClicked !== undefined

	return (
		<span class = 'inline-card' role = 'figure' style = { props.style } title = { props.label }>
			{ props.warningMessage ? <WarningSign message = { props.warningMessage } isTrailingSign = { false } /> : <></> }
			<span role = 'img'><Icon /></span>
			<data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data>
			<span class = 'inline-card-actions' role = { hasAction ? 'group' : undefined } aria-hidden = { props.nonInteractive || !hasAction } aria-label = { props.noExpandButtons || props.nonInteractive || !hasAction ? undefined : 'Spell-out actions' }>
				{ props.nonInteractive ? <>
					<span role = 'img'><Icon /></span>
					<span><data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
				</> : !props.noCopy && props.copyOnActionOnly ? <>
					<span class = 'inline-card-expanded-label'>
						<span role = 'img'><Icon /></span>
						<span><data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
					</span>
					<button class = 'inline-card-copy-action' type = 'button' onClick = { copyTextToClipboard } value = { props.copyValue } aria-label = { `Copy ${ props.label }` }>
						<span title = 'Copy'>
							<CopyIcon />
							<span>copy</span>
						</span>
					</button>
				</> : !props.noCopy ? (
					<button type = 'button' onClick = { copyTextToClipboard } value = { props.copyValue }>
						<span role = 'img'><Icon /></span>
						<span><data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
						<span title = 'Copy'>
							<CopyIcon />
							<span>copy</span>
						</span>
					</button>
				) : <>
					<span class = 'inline-card-static-action'>
						<span role = 'img'><Icon /></span>
						<span><data class = 'text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
					</span>
				</>
				}
				{ props.onEditClicked ? (
					<button type = 'button' value = { props.copyValue } onClick = { edit }>
						<span title = 'Edit'>
							<EditIcon />
							<span>edit</span>
						</span>
					</button>
				) : <></> }
			</span>
			{ props.warningMessage ? <WarningSign message = { props.warningMessage } isTrailingSign = { true } /> : <></> }
			<Tooltip config = { tooltip } />
		</span>
	)
}

type WarningSignProps = {
	message: string
	// The card shows a sign on both sides of its label; only the leading sign is focusable and announced, so keyboard and screen reader users meet the warning once.
	isTrailingSign: boolean
}

const WarningSign = ({ message, isTrailingSign }: WarningSignProps) => {
	// The surrounding Hint container shows data-tooltip on hover and keyboard focus. The empty title stops the card's label title from also appearing as a native tooltip over the sign. The sign is a named image rather than an alert, because an alert is a live region that would read the whole warning aloud every time a token card renders.
	return <span
		class = 'inline-card-warning-sign'
		role = { isTrailingSign ? undefined : 'img' }
		data-tooltip = { message }
		title = ''
		aria-label = { isTrailingSign ? undefined : message }
		aria-hidden = { isTrailingSign ? true : undefined }
		tabIndex = { isTrailingSign ? undefined : 0 }
	>⚠</span>
}
