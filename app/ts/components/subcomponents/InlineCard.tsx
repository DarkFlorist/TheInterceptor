import { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { clipboardCopy } from './clipboardcopy.js'
import { CopyIcon, EditIcon } from './icons.js'
import { Tooltip, TooltipConfig } from './Tooltip.js'

type InlineCardProps = {
	icon: () => JSX.Element
	label: string
	copyValue?: string | undefined
	noCopy?: boolean | undefined
	style?: JSX.CSSProperties | undefined
	onEditClicked?: JSX.MouseEventHandler<HTMLButtonElement> | undefined
	statusMessageDuration?: number | undefined
	warningMessage?: string | undefined
	noExpandButtons?: boolean | undefined
}

export const InlineCard = (props: InlineCardProps) => {
	const tooltip = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value || props.label)
		tooltip.value = { message: 'Copied!', x: event.clientX, y: event.clientY, duration: props.statusMessageDuration || 1500 }
	}

	const Icon = props.icon

	return (
		<span class = 'inline-card' role = 'figure' style = { props.style } title = { props.label }>
			{ props.warningMessage ? <WarningSign /> : <></> }
			<span role = 'img'><Icon /></span>
			<data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data>
			<span role = 'menu' aria-label = { props.noExpandButtons ? undefined : 'Spell-out actions' }>
				{ !props.noCopy ? (
					<button type = 'button' onClick = { copyTextToClipboard } value = { props.copyValue } tabIndex = { 1 }>
						<span role = 'img'><Icon /></span>
						<span><data class = 'truncate text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
						<span title = 'Copy'>
							<CopyIcon />
							<span>copy</span>
						</span>
					</button>
				) : <>
					<button type = 'button' value = { props.copyValue } tabIndex = { 1 } style = { { pointerEvents: 'none' } }>
						<span role = 'img'><Icon /></span>
						<span><data class = 'text-legible' style = { props.style } value = { props.label }>{ props.label }</data></span>
					</button>
				</>
				}
				{ props.onEditClicked ? (
					<button type = 'button' value = { props.copyValue } onClick = { props.onEditClicked } tabIndex = { 1 }>
						<span title = 'Edit'>
							<EditIcon />
							<span>edit</span>
						</span>
					</button>
				) : <></> }
			</span>
			{ props.warningMessage ? <WarningSign /> : <></> }
			<Tooltip config = { tooltip } />
		</span>
	)
}

const WarningSign = ({ message = 'Warning' }: { message?: string }) => {
	return <span role = 'alert' title = { message }>⚠</span>
}
