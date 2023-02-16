interface ErrorProps {
	text: string
}

export function Error(props: ErrorProps) {
	return (
		<div class = 'container'>
			<div className = 'notification' style = 'background-color: var(--error-box-color); display: flex; align-items: center; padding: 2px; padding: 10px'>
				<span class = 'icon' style = 'margin-left: 0px; margin-right: 5px; width: 2em; height: 2em;'>
					<img src = '../img/warning-sign-black.svg' />
				</span>
				<p className = 'paragraph' style = 'marging-left: 10px; color: var(--error-box-text);'> { props.text } </p>
			</div>
		</div>
	)
}

export function Notice(props: ErrorProps) {
	return (
		<div class = 'container'>
			<div className = 'notification' style = { `background-color: unset; display: flex; align-items: center; padding: 0px;` }>
				<p className = 'paragraph' style = 'marging-left: 10px'> { props.text } </p>
			</div>
		</div>
	)
}

interface ErrorCheckboxProps {
	text: string
	checked: boolean
	onInput: (checked: boolean) => void
}

export function ErrorCheckBox(props: ErrorCheckboxProps) {
	return (
		<div class = 'container'>
			<div className = 'notification' style = 'background-color: var(--error-box-color); padding: 10px;'>
				<label class = 'form-control' style = 'color: var(--error-box-text); font-size: 1em;'>
					<input type = 'checkbox'
						checked = { props.checked }
						onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { props.onInput(e.target.checked) } } }
					/>
					{ props.text }
				</label>
			</div>
		</div>
	)
}
