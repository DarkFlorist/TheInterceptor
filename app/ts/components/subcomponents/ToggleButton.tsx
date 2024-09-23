type ToggleButtonProps = {
	id: string
	checked: boolean
	checkedLabel: string
	uncheckedLabel: string
	onChange: (checked: boolean) => void
}

export const ToggleButton = ({ id, checked, checkedLabel, uncheckedLabel, onChange }: ToggleButtonProps) => {
	const onToggle = (e: Event) => {
		if (e.target instanceof HTMLInputElement) {
			onChange(e.target.checked)
		}
	}

	return (
		<form onChange={ onToggle }>
			<label htmlFor={id}>{ checked ? checkedLabel : uncheckedLabel }</label>
			<input id = { id } type = 'checkbox' checked = { checked } onChange = { () => onChange(!checked) } />
		</form>
	)
}
