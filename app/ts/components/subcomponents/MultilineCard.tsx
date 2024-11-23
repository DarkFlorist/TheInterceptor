import { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { Tooltip, TooltipConfig } from './Tooltip.js'
import { clipboardCopy } from './clipboardcopy.js'
import { CopyIcon } from './icons.js'

export type MultilineCardProps = {
	icon: ActionableIconProps
	label: ActionableTextProps
	note: ActionableTextProps
	style?: JSX.CSSProperties
}

export const MultilineCard = ({ icon, label, note, style }: MultilineCardProps) => {
	return (
		<figure class = 'multiline-card' role = 'figure' style = { style }>
			<ActionableIcon { ...icon } />
			<ActionableText { ...label } />
			<ActionableText { ...note } />
		</figure>
	)
}

export type ActionableIconProps = {
	onClick: 'clipboard-copy'
	icon: () => JSX.Element
	copyValue?: string
	copySuccessMessage: string
	hintText?: string
} | {
	onClick: JSX.MouseEventHandler<HTMLButtonElement>
	icon: () => JSX.Element
	hintText?: string
} | {
	onClick: undefined
	icon: () => JSX.Element
}

const ActionableIcon = (props: ActionableIconProps) => {
	const tooltipConfig = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value)
		const copySuccessMessage = props.onClick === 'clipboard-copy' && props.copySuccessMessage ? props.copySuccessMessage : 'Copied!'
		tooltipConfig.value = { message: copySuccessMessage, x: event.clientX, y: event.clientY }
	}

	const CardIcon = props.icon
	const handleClick = props.onClick ? props.onClick === 'clipboard-copy' ? copyTextToClipboard : props.onClick : undefined
	const copyValue = props.onClick === 'clipboard-copy' ? props.copyValue : undefined
	const hintText = props.onClick ? props.hintText : undefined

	return (
		<span role = 'img'>
			<button type = 'button' onClick = { handleClick } tabIndex = { -1 } value = { copyValue } title = { hintText } disabled = { !props.onClick }>
				<CardIcon />
				<Tooltip config = { tooltipConfig } />
			</button>
		</span>
	)
}

type TextNodeProps = {
	displayText: string,
	value: string
}

const TextNode = ({ displayText, value }: TextNodeProps) => <data class = 'truncate text-legible' value = { value || displayText }>{ displayText }</data>

export type ActionableTextProps = {
	onClick: 'clipboard-copy'
	displayText: string
	copyValue?: string
	copySuccessMessage?: string
} | {
	onClick: JSX.MouseEventHandler<HTMLButtonElement>
	displayText: string
	buttonLabel: string
	buttonIcon: () => JSX.Element
} | {
	onClick?: undefined
	displayText: string
}

const ActionableText = (props: ActionableTextProps) => {
	const tooltipConfig = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value)
		tooltipConfig.value = {
			message: props.onClick === 'clipboard-copy' && props.copySuccessMessage ? props.copySuccessMessage : 'Copied!',
			x: event.clientX,
			y: event.clientY
		}
	}

	const copyValue = props.onClick === 'clipboard-copy' && props.copyValue ? props.copyValue : props.displayText
	const actionIcon = props.onClick ? props.onClick === 'clipboard-copy' ? () => <CopyIcon /> : props.buttonIcon : () => <></>
	const actionHandler = props.onClick ? props.onClick === 'clipboard-copy' ? copyTextToClipboard : props.onClick : undefined
	const actionButtonLabel = props.onClick ? props.onClick === 'clipboard-copy' ? 'Copy' : props.buttonLabel : ''

	const DisplayText = () => <TextNode displayText = { props.displayText } value = { copyValue } />

	return (
		<span>
			<DisplayText />
			<TextAction buttonLabel = { actionButtonLabel } textNode = { DisplayText } buttonIcon = { actionIcon } onClick = { actionHandler } copyValue = { copyValue } />
			<Tooltip config = { tooltipConfig } />
		</span>
	)
}

type TextActionProps = {
	onClick: undefined
	textNode: () => JSX.Element
} | {
	onClick: JSX.MouseEventHandler<HTMLButtonElement>
	textNode: () => JSX.Element
	buttonLabel: string
	buttonIcon: () => JSX.Element
	copyValue?: string
}

const TextAction = (props: TextActionProps) => {
	const DisplayText = props.textNode
	const ActionIcon = props.onClick ? props.buttonIcon : () => <></>

	return (
		<button type = 'button' onClick = { props.onClick } value = { props.onClick ? props.copyValue : undefined } tabIndex = { 1 } disabled = { !props.onClick }>
			<DisplayText />
			<span>
				<ActionIcon />
				<span>{ props.onClick ? props.buttonLabel : '' }</span>
			</span>
		</button>
	)
}

