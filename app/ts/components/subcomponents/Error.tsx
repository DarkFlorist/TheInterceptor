import { Component, type ComponentChild, type ComponentChildren, type JSX } from 'preact'
import type { Signal } from '@preact/signals'
import { SomeTimeAgo } from './SomeTimeAgo.js'
import { resolveSignal, type SignalOrValue } from '../../utils/signals.js'
import { WarningSignIcon } from './icons.js'

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
	return (
		<div class = 'error-container' style = { props.containerStyle }>
			<div class = 'notification error-notification' data-severity = { props.warning === true ? 'warning' : 'error' } style = { `background-color: ${ boxColor };` }>
				<span class = 'error-notification-icon'><WarningSignIcon/></span>
				<p class = 'paragraph error-notification-text' style = { `color: ${ textColor };` }> { resolveSignal(props.text) } </p>
			</div>
		</div>
	)
}

export function Notice(props: ErrorProps) {
	return (
		<div>
			<div class = 'notification error-notice'>
				<p class = 'paragraph error-notice-text'> { resolveSignal(props.text) } </p>
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
			<div class = 'notification error-notification' data-severity = { props.warning === true ? 'warning' : 'error' } style = { `background-color: ${ boxColor };` }>
				<label class = 'form-control error-checkbox-label' style = { `color: ${ textColor };` }>
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
	const metadata = [
		error.source === undefined ? undefined : `source: ${ error.source }`,
		error.code === undefined ? undefined : `code: ${ error.code }`,
		error.debugId === undefined ? undefined : `debug: ${ error.debugId }`,
	].filter((value): value is string => value !== undefined)
	return (
		<div class = 'notification unexpected-error-notification' data-severity = 'error'>
			<div class = 'error-unexpected-heading'>
				<span class = 'error-notification-icon'><WarningSignIcon/></span>
				<p class = 'paragraph error-unexpected-title'>
					An unexpected error occured! <SomeTimeAgo priorTimestamp = { error.timestamp } /> ago
				</p>
			</div>
			<div class = 'unexpected-error-message'>
				<p class = 'paragraph error-unexpected-text'> { error.message } </p>
				{ metadata.length > 0 ? <p class = 'paragraph error-unexpected-text error-unexpected-text--metadata'> { metadata.join(' | ') } </p> : <></> }
			</div>
			<div class = 'error-unexpected-actions'>
				<button class = 'button button--secondary' onClick = { close }> { 'close' } </button>
			</div>
		</div>
	)
}
