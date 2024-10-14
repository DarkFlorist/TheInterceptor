import { CSSProperties, JSX } from 'preact/compat'

const cardActions = ['copy', 'edit'] as const

export type InlineCardSelectValue = {
	action: typeof cardActions[number]
	value: string
}

export type InlineCardProps = {
	icon: () => JSX.Element
	label: string,
	style?: CSSProperties,
	onSelect?: (selection: InlineCardSelectValue) => void
}

export const InlineCard = ({ icon: Icon, label, onSelect, style }: InlineCardProps) => {
	const isValidAction = (action: string): action is typeof cardActions[number] => cardActions.some(a => a === action)

	const handleSelect = (event: Event) => {
		let action:InlineCardSelectValue['action'] = 'copy'
		if (event.currentTarget instanceof HTMLButtonElement && isValidAction(event.currentTarget.value)) {
			event.stopPropagation()
			action = event.currentTarget.value
			event.currentTarget.blur()
		}
		onSelect?.({ action, value: label })
	}

	return (
		<span class = 'inline-card' role = 'figure' style = { style }>
			<span role = 'img'><Icon /></span>
			<data class = 'truncate text-legible' value = { label }>{label}</data>
			<span role = 'menu'>
				<span role = 'menuitem' onClick = { () => onSelect?.({ action: 'copy', value: label }) }>
					<span role = 'img'><Icon /></span>
					<span><data class = 'truncate text-legible' value = { label }>{label}</data></span>
					<button type = 'button' value = 'copy' tabIndex = { 1 } onClick = { handleSelect }>
						<svg width = '1em' height = '1em' viewBox = '0 0 24 24' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'><path d = 'M14.188 4.813H4.813v9.375h.937V17H3.875A1.875 1.875 0 0 1 2 15.125V3.875C2 2.839 2.84 2 3.875 2h11.25C16.16 2 17 2.84 17 3.875V5.75h-2.812z' fill = 'currentColor' /><path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M7 20V9a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2m12-1h-9v-9h9z' fill = 'currentColor' /></svg>
						<span>copy</span>
					</button>
				</span>
				<span role = 'menuitem'>
					<button type = 'button' value = 'edit' tabIndex = { 1 } onClick = { handleSelect }>
						<svg width = '1em' height = '1em' viewBox = '0 0 24 24' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'><path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M10 3H7v2H4a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h3v2h3zM7 8v8H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z' fill = 'currentColor' /><path d = 'M19 16h-7v3h8a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3h-8v3h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1' fill = 'currentColor' /></svg>
						<span>edit</span>
					</button>
				</span>
			</span>
		</span>
	)
}
