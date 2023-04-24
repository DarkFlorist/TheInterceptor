import type { ComponentChild } from 'preact'

interface ErrorProps {
	text: ComponentChild
	warning?: boolean,
}

export function Error(props: ErrorProps) {
	const boxColor = props.warning === true ? 'var(--warning-box-color)' : 'var(--error-box-color)'
	const textColor = props.warning === true ? 'var(--warning-box-text)' : 'var(--error-box-text)'
	return (
		<div class = 'container'>
			<div className = 'notification' style = { `background-color: ${ boxColor }; display: flex; align-items: center; padding: 2px; padding: 10px`}>
				<span class = 'icon' style = 'margin-left: 0px; margin-right: 5px; width: 2em; height: 2em; min-width: 2em; min-height: 2em;'>
					<img src = '../img/warning-sign-black.svg' style = 'width: 2em; height: 2em;'/>
				</span>
				<p className = 'paragraph' style = { `marging-left: 10px; color: ${ textColor }` }> { props.text } </p>
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
	warning?: boolean,
}

export function ErrorCheckBox(props: ErrorCheckboxProps) {
	const boxColor = props.warning === true ? 'var(--warning-box-color)' : 'var(--error-box-color)'
	const textColor = props.warning === true ? 'var(--warning-box-text)' : 'var(--error-box-text)'
	return (
		<div class = 'container'>
			<div className = 'notification' style = { `background-color: ${ boxColor }; padding: 10px;` }>
				<label class = 'form-control' style = { `color: ${ textColor }; font-size: 1em;` }>
					<input type = 'checkbox'
						checked = { props.checked }
						onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { props.onInput(e.target.checked) } } }
					/>
					<p class = 'paragraph checkbox-text' style = { `color: ${ textColor };` }> { props.text } </p>
				</label>
			</div>
		</div>
	)
}
