import { Component, type ComponentChild, type ComponentChildren, type JSX } from 'preact'
import type { Signal } from '@preact/signals'
import { SomeTimeAgo } from './SomeTimeAgo.js'
import { resolveSignal, type SignalOrValue } from '../../utils/signals.js'

interface ErrorProps {
	text: SignalOrValue<ComponentChild>
	warning?: boolean,
	containerStyle?: JSX.CSSProperties
}

export function ErrorText(props: ErrorProps) {
	const textColor = props.warning === true ? 'var(--warning-box-color)' : 'var(--error-box-color)'
	return <p class = 'paragraph' style = { `color: ${ textColor }` }> { resolveSignal(props.text) } </p>
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
			<div class = 'notification' style = { `background-color: ${ boxColor }; display: flex; align-items: flex-start; gap: 10px; padding: 10px;` }>
				<span class = 'icon' style = 'margin-left: 0px; margin-right: 0px; width: 2em; height: 2em; min-width: 2em; min-height: 2em; flex: 0 0 auto;'>
					<img src = '../img/warning-sign-black.svg' width = '32' height = '32' style = 'width: 2em; height: 2em;'/>
				</span>
				<p class = 'paragraph' style = { `margin: 0px; min-width: 0; flex: 1; color: ${ textColor }; white-space: normal; overflow-wrap: anywhere; word-break: break-word;` }> { resolveSignal(props.text) } </p>
			</div>
		</div>
	)
}

export function Notice(props: ErrorProps) {
	return (
		<div>
			<div class = 'notification' style = { 'background-color: unset; display: flex; align-items: center; padding: 0px;' }>
				<p class = 'paragraph' style = 'margin-left: 10px'> { resolveSignal(props.text) } </p>
			</div>
		</div>
	)
}

interface ErrorCheckboxProps {
	text: SignalOrValue<string>
	checked: Signal<boolean>
	warning?: boolean,
}

export function ErrorCheckBox(props: ErrorCheckboxProps) {
	const boxColor = props.warning === true ? 'var(--warning-box-color)' : 'var(--error-box-color)'
	const textColor = props.warning === true ? 'var(--warning-box-text)' : 'var(--error-box-text)'
	return (
		<div>
			<div class = 'notification' style = { `background-color: ${ boxColor }; padding: 10px;` }>
				<label class = 'form-control' style = { `color: ${ textColor }; font-size: 1em;` }>
					<input type = 'checkbox'
						checked = { props.checked.value }
						onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { props.checked.value = e.target.checked } } }
					/>
					<p class = 'paragraph checkbox-text' style = { `color: ${ textColor };` }> { resolveSignal(props.text) } </p>
				</label>
			</div>
		</div>
	)
}


type ErrorBoundaryState = { error: Error, timestamp: Date } | { error: undefined, timestamp: undefined }

export class ErrorBoundary extends Component<{ children?: ComponentChildren, onError?: (error: Error) => void }, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { error: undefined, timestamp: undefined }

	static override getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error, timestamp: new Date() }
	}

	override componentDidCatch(error: Error) {
		console.error('Caught rendering error:', error)
		this.props.onError?.(error)
	}

	dismiss = () => this.setState({ error: undefined })

	override render() {
		if (this.state.error !== undefined) {
			if (this.props.onError !== undefined) return null
			return <UnexpectedError error = { { message: this.state.error.message, timestamp: this.state.timestamp } } close = { this.dismiss } />
		}
		return this.props.children
	}
}

export type CaughtError = {
	message: string
	timestamp: Date
	source?: string
	code?: string
	debugId?: string
}

type UnexpectedErrorParams = {
	error: CaughtError | undefined
	close: () => void
}

export function UnexpectedError({ error, close }: UnexpectedErrorParams) {
	if (error === undefined) return <></>
	return (
		<div class = 'notification' style = { 'background-color: var(--error-box-color); padding: 10px; margin: 10px;' }>
			<div style = 'display: flex; padding-bottom: 10px;'>
				<span class = 'icon' style = 'margin-left: 0px; margin-right: 5px; width: 2em; height: 2em; min-width: 2em; min-height: 2em;'>
					<img src = '../img/warning-sign-black.svg' width = '32' height = '32' style = 'width: 2em; height: 2em;'/>
				</span>
				<p class = 'paragraph' style = { 'margin-left: 10px; color: var(--error-box-text); align-self: center; font-weight: bold;' }>
					An unexpected error occured! <SomeTimeAgo priorTimestamp = { error.timestamp } /> ago
				</p>
			</div>
			<div style = { 'overflow-y: auto; overflow-x: hidden; max-height: 100px; border-style: solid;' }>
				<p class = 'paragraph' style = { 'color: var(--error-box-text);' }> { error.message } </p>
			</div>
			<div style = 'overflow: hidden; display: flex; justify-content: space-around; width: 100%; height: 50px; padding-top: 10px;'>
				<button class = 'button is-success is-primary' onClick = { close }> { 'close' } </button>
			</div>
		</div>
	)
}
