import type { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { clipboardCopy } from './clipboardcopy.js'
import Hint from './Hint.js'
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
	// Explained on hover and keyboard focus by the Hint the card wraps itself in, so the card needs no Hint container around it.
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

	const card = (
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

	// One Hint for the whole card holds a single explanation, so focus on the leading sign and the pointer over the trailing sign share it instead of showing it twice. It watches data-warning-tooltip, which a page Hint ignores, and only wraps cards with a warning, so other cards keep their place in selectors such as .safe-signer-option-address > .inline-card.
	return props.warningMessage ? <Hint attribute = 'data-warning-tooltip' inline>{ card }</Hint> : card
}

type WarningSignProps = {
	message: string
	// The card shows a sign on both sides of its label; only the leading sign is an alert and focusable, so screen reader and keyboard users meet the warning once per card.
	isTrailingSign: boolean
}

const WarningSign = ({ message, isTrailingSign }: WarningSignProps) => {
	// The leading sign is an alert so screen readers proactively announce this anti-phishing warning, such as a token impersonating a well-known one, as soon as the card renders; its aria-label makes that announcement and its reading-order name carry the full explanation. The trailing sign is aria-hidden so the warning is announced once per card instead of twice. The card's own Hint shows data-warning-tooltip on hover of either sign and on keyboard focus of the leading sign wherever the card renders. The sign must not also carry data-tooltip, which a page Hint would show a second time; the InlineCard warning sign tests render the card inside a page Hint and fail if the explanation appears twice. The empty title stops the card's label title from appearing as a native tooltip over the sign.
	return <span
		class = 'inline-card-warning-sign'
		role = { isTrailingSign ? undefined : 'alert' }
		data-warning-tooltip = { message }
		title = ''
		aria-label = { isTrailingSign ? undefined : message }
		aria-hidden = { isTrailingSign ? true : undefined }
		tabIndex = { isTrailingSign ? undefined : 0 }
	>⚠</span>
}
