import type { ComponentChildren, JSX } from 'preact'
import type { AsyncStates } from '../../utils/preact-utilities.js'
import { Spinner } from './Spinner.js'
import { XMarkIcon } from './icons.js'

type AsyncStatusIconProps = {
	state: AsyncStates
	size?: string
}

function SpinnerIcon({ size = '1em' }: { size?: string }) {
	return (
		<span aria-hidden = 'true' style = { { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0 } }>
			<Spinner height = { size } color = 'currentColor' />
		</span>
	)
}

function CheckIcon({ size = '1em' }: { size?: string }) {
	return (
		<span aria-hidden = 'true' style = { { color: 'var(--positive-color, currentColor)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0 } }>
			<svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
				<path d = 'M3 8.5L6.5 12L13 4.5' stroke = 'currentColor' stroke-width = '2' stroke-linecap = 'round' stroke-linejoin = 'round' />
			</svg>
		</span>
	)
}

export function AsyncStatusIcon({ state, size = '1em' }: AsyncStatusIconProps) {
	switch (state) {
		case 'inactive': return <></>
		case 'pending': return <SpinnerIcon size = { size } />
		case 'rejected': return <span aria-hidden = 'true' style = { { color: 'var(--negative-color)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0 } }><XMarkIcon /></span>
		case 'resolved': return <CheckIcon size = { size } />
	}
}

type AsyncActionButtonProps = {
	state: AsyncStates
	text: ComponentChildren
	pendingText: ComponentChildren
	onClick: () => void | Promise<void>
	disabled?: boolean
	class?: string
	style?: JSX.CSSProperties | string
	type?: 'button' | 'submit' | 'reset'
}

export function AsyncActionButton(props: AsyncActionButtonProps) {
	const pending = props.state === 'pending'
	return (
		<button
			type = { props.type ?? 'button' }
			class = { props.class }
			style = { props.style }
			onClick = { props.onClick }
			disabled = { props.disabled || pending }
			aria-busy = { pending }
		>
			{ pending
				? <span style = { { display: 'inline-flex', alignItems: 'center', gap: '0.5em' } }>
					<AsyncStatusIcon state = 'pending' />
					<span>{ props.pendingText }</span>
				</span>
				: props.text
			}
		</button>
	)
}
