import { JSX } from 'preact/jsx-runtime'
import { useSignal, useSignalEffect } from '@preact/signals'
import { clipboardCopy } from './clipboardcopy.js'
import { CheckIcon, CopyIcon, EditIcon } from './icons.js'

export type InlineCardProps = {
	icon: () => JSX.Element
	label: string
	value?: string
	style?: JSX.CSSProperties
	onEditClick?: JSX.MouseEventHandler<HTMLButtonElement>
	statusMessageDuration?: number
}

export const InlineCard = ({ icon: Icon, label, value, onEditClick, style, statusMessageDuration = 1500 }: InlineCardProps) => {
	const copyStatus = useSignal(false)

	const copyTextToClipboard = async (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		event.currentTarget.blur()
		await clipboardCopy(label)
		copyStatus.value = true
	}

	useSignalEffect(() => {
		if (copyStatus.value !== true) return
		setTimeout(() => copyStatus.value = false, statusMessageDuration)
	})

	return (
		<>
			<span class = 'inline-card' role = 'figure' style = { style } title = { label }>
				<span role = 'img'><Icon /></span>
				<data class = 'truncate text-legible' value = { label }>{label}</data>
				<span role = 'menu'>
					<button type = 'button' onClick = { copyTextToClipboard } tabIndex = { 1 }>
						<span role = 'img'><Icon /></span>
						<span><data class = 'truncate text-legible' value = { label }>{label}</data></span>
						<span>
							<CopyIcon />
							<span>copy</span>
						</span>
					</button>
					<button type = 'button' value = { value } onClick = { onEditClick } tabIndex = { 1 }>
						<span>
							<EditIcon />
							<span>edit</span>
						</span>
					</button>
				</span>

				{ copyStatus.value ? <span role='status'><CheckIcon /><span>Copied!</span></span> : <></> }
			</span>
		</>
	)
}
