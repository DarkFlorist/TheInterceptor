import type { ComponentChild, JSX } from 'preact'
import { UnexpectedErrorOccured } from '../../types/interceptor-messages.js'
import { SomeTimeAgo } from './SomeTimeAgo.js'

interface ErrorProps {
	text: ComponentChild
	warning?: boolean,
	containerStyle?: JSX.CSSProperties
}

export function ErrorComponent(props: ErrorProps) {
	const boxColor = props.warning === true ? 'var(--warning-box-color)' : 'var(--error-box-color)'
	const textColor = props.warning === true ? 'var(--warning-box-text)' : 'var(--error-box-text)'
	const containerStyle = {
		margin: '10px',
		backgroundColor: 'var(--bg-color)',
		...props.containerStyle
	}
	return (
		<div style = { containerStyle }>
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
		<div>
			<div className = 'notification' style = { 'background-color: unset; display: flex; align-items: center; padding: 0px;' }>
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
		<div>
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

type UnexpectedErrorParams = {
	unexpectedError: UnexpectedErrorOccured | undefined
	close: () => void
}

export const UnexpectedError = ({ unexpectedError, close }: UnexpectedErrorParams) => {
	if (unexpectedError?.data.message === undefined) return <></>
	return (
		<div className = 'notification' style = { 'background-color: var(--error-box-color); padding: 10px; margin: 10px;' }>
			<div style = 'display: flex; padding-bottom: 10px;'>
				<span class = 'icon' style = 'margin-left: 0px; margin-right: 5px; width: 2em; height: 2em; min-width: 2em; min-height: 2em;'>
					<img src = '../img/warning-sign-black.svg' style = 'width: 2em; height: 2em;'/>
				</span>
				<p className = 'paragraph' style = { 'marging-left: 10px; color: var(--error-box-text); align-self: center; font-weight: bold;' }> An unexpected error occured! <SomeTimeAgo priorTimestamp = { unexpectedError.data.timestamp } /> ago </p>
			</div>
			<div style = { 'overflow-y: auto; overflow-x: hidden; max-height: 100px; border-style: solid;' }>
				<p class = 'paragraph' style = { 'color: var(--error-box-text);' }> { unexpectedError?.data.message } </p>
			</div>
			<div style = 'overflow: hidden; display: flex; justify-content: space-around; width: 100%; height: 50px; padding-top: 10px;'>
				<button class = 'button is-success is-primary' onClick = { close }> { 'close' } </button>
			</div>
		</div>
	)
}
