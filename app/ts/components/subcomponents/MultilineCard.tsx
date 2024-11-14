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

type ActionableIconAction = {
	onClick: JSX.MouseEventHandler<HTMLButtonElement>
	hintText?: string
}

export type ActionableIconProps = {
	icon: () => JSX.Element
	hintText?: string
	action: 'clipboard-copy'
	copyValue?: string
	copySuccessMessage?: string
} | {
	icon: () => JSX.Element
	hintText?: string
	action?: ActionableIconAction
}

const ActionableIcon = (props: ActionableIconProps) => {
	const tooltipConfig = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value)
		const copySuccessMessage = props.action === 'clipboard-copy' && props.copySuccessMessage ? props.copySuccessMessage : 'Copied!'
		tooltipConfig.value = { message: copySuccessMessage, x: event.clientX, y: event.clientY }
	}

	const CardIcon = props.icon
	const handleClick = props.action ? props.action === 'clipboard-copy' ? copyTextToClipboard  : props.action.onClick : undefined
	const copyValue =  props.action === 'clipboard-copy' ? props.copyValue : undefined
	const hintText = props.action !== 'clipboard-copy' ? props.action?.hintText : undefined

	return (
		<span role = 'img'>
			<button type = 'button' onClick = { handleClick } tabIndex = { -1 } value = { copyValue } title = { hintText } disabled = { !props.action }>
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
	displayText: string
	action: 'clipboard-copy'
	copyValue?: string
	copySuccessMessage?: string
} | {
	displayText: string
	action?: ActionableTextAction
}

type ActionableTextAction = {
	label: string
	icon: () => JSX.Element
	onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}

const ActionableText = (props: ActionableTextProps) => {
	const tooltipConfig = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value)
		tooltipConfig.value = { message: 'Copied!', x: event.clientX, y: event.clientY }
	}

	const copyValue = props.action === 'clipboard-copy' && props.copyValue ? props.copyValue : props.displayText
	const DisplayText = () => <TextNode displayText = { props.displayText } value = { copyValue } />

	const actionIcon = props.action ? props.action === 'clipboard-copy' ? () => <CopyIcon /> : props.action.icon : () => <></>
	const actionHandler = props.action ? props.action === 'clipboard-copy' ? copyTextToClipboard : props.action.onClick : undefined
	const actionButtonLabel = props.action === 'clipboard-copy' ? 'Copy' : props.action?.label || ''

	return (
		<span>
			<DisplayText />
			<TextAction label = { actionButtonLabel } textNode = { DisplayText } icon = { actionIcon } onClick = { actionHandler } copyValue = { copyValue }  />
			<Tooltip config = { tooltipConfig } />
		</span>
	)
}

type TextActionProps = ActionableTextAction & {
	textNode: () => JSX.Element
	copyValue: string
}

const TextAction = (props: TextActionProps) => {
	const DisplayText = props.textNode
	const ActionIcon = props.icon

	return (
		<button type = 'button' onClick = { props.onClick } value = { props.copyValue } tabIndex = { 1 } disabled = { !props.onClick }>
			<DisplayText />
			<span>
				<ActionIcon />
				<span>{ props.label }</span>
			</span>
		</button>
	)
}

