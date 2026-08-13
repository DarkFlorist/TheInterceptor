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

	return (
		<span class = 'inline-card' role = 'figure' style = { props.style } title = { props.label }>
			{ props.warningMessage ? <WarningSign message = { props.warningMessage } /> : <></> }
			<span role = 'img'><Icon /></span>
			<data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data>
			<span role = 'group' aria-hidden = { props.nonInteractive } aria-label = { props.noExpandButtons || props.nonInteractive ? undefined : 'Spell-out actions' }>
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
			{ props.warningMessage ? <WarningSign message = { props.warningMessage } /> : <></> }
			<Tooltip config = { tooltip } />
		</span>
	)
}

const WarningSign = ({ message = 'Warning' }: { message?: string }) => {
	return <span role = 'alert' title = { message }>⚠</span>
}
