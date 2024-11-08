import { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { Tooltip, TooltipConfig } from './Tooltip.js'
import { clipboardCopy } from './clipboardcopy.js'
import { CopyIcon } from './icons.js'

export type CardIcon = {
	component: () => JSX.Element
	onClick?: () => void
	tooltipText?: string
}

export type MultilineCardProps = {
	icon: CardIcon
	label: ActionableTextProps
	note: ActionableTextProps
	style?: JSX.CSSProperties
}

export const MultilineCard = ({ icon, label, note, style }: MultilineCardProps) => {
	const tooltipConfig = useSignal<TooltipConfig | undefined>(undefined)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(event.currentTarget.value)
		tooltipConfig.value = { message: 'Copied!', x: event.clientX, y: event.clientY }
	}

	const CardIcon = icon.component
	const defaultAction:TextAction = { label: 'Copy', icon: () => <CopyIcon />, onClick: copyTextToClipboard }

	return (
		<>
			<figure class = 'multiline-card' role = 'figure' style = { style }>
				<span role = 'img'>
					<button type = 'button' onClick = { icon.onClick || copyTextToClipboard } tabIndex = { -1 } title = { icon.tooltipText || label.displayText }><CardIcon /></button>
				</span>
				<ActionableText { ...label } action = { !label.action ? defaultAction : label.action } />
				<ActionableText { ...note } action = { !note.action ? defaultAction : note.action } />
			</figure>
			<Tooltip config = { tooltipConfig } />
		</>
	)
}

export type TextAction = {
	label: string
	icon: () => JSX.Element
	onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}

export type ActionableTextProps = {
	displayText: string
	value?: string
	action: TextAction | 'noaction' | undefined
}

type TextNodeProps = {
	displayText: string,
	value: string
}

const TextNode = ({ displayText, value }: TextNodeProps) => <data class = 'truncate text-legible' value = { value || displayText }>{ displayText }</data>

const ActionableText = ({ displayText, value, action }: ActionableTextProps) => {
	const DisplayText = () => <TextNode displayText = { displayText } value = { value || displayText } />
	return (
		<span>
			<DisplayText />
			{ action !== undefined && action !== 'noaction' ? <TextAction { ...action } textNode = { DisplayText } /> : <></> }
		</span>
	)
}

type TextActionProps = {
	icon: () => JSX.Element
	textNode: () => JSX.Element
	label: string
	onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}

const TextAction = ({ textNode: DisplayText, icon: ActionIcon, label, onClick }: TextActionProps) => {
	return (
		<button type = 'button' onClick = { onClick } value = { '' } tabIndex = { 1 }>
			<DisplayText />
			<span>
				<ActionIcon />
				<span>{ label }</span>
			</span>
		</button>
	)
}

