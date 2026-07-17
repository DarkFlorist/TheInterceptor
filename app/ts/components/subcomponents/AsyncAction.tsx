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
	keepTextWhilePending?: boolean
	pendingIndicatorPlacement?: 'inline' | 'overlay'
	onClick: () => void | Promise<void>
	disabled?: boolean
	class?: string
	style?: JSX.CSSProperties | string
	type?: 'button' | 'submit' | 'reset'
}

type PendingButtonContentProps = {
	children: ComponentChildren
	pending: boolean
	pendingIndicatorPlacement: 'inline' | 'overlay'
}

function PendingButtonContent({ children, pending, pendingIndicatorPlacement }: PendingButtonContentProps) {
	const indicatorSize = pendingIndicatorPlacement === 'overlay' ? '0.75em' : '1em'
	const indicator = pending ? <AsyncStatusIcon state = 'pending' size = { indicatorSize } /> : <></>
	if (pendingIndicatorPlacement === 'overlay') {
		return <span class = 'async-action-button__stable-content' style = { { display: 'inline-flex', alignItems: 'center', position: 'relative' } }>
			<span
				class = 'async-action-button__status-slot'
				aria-hidden = 'true'
				style = { { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'absolute', right: 'calc(100% + 0.125em)', top: '50%', transform: 'translateY(-50%)', width: indicatorSize, height: indicatorSize, lineHeight: 0, pointerEvents: 'none', visibility: pending ? 'visible' : 'hidden' } }
			>
				{ indicator }
			</span>
			{ children }
		</span>
	}
	if (!pending) return <>{ children }</>
	return <span class = 'async-action-button__inline-content' style = { { display: 'inline-flex', alignItems: 'center', gap: '0.5em' } }>
		{ indicator }
		<span>{ children }</span>
	</span>
}

export function AsyncActionButton(props: AsyncActionButtonProps) {
	const pending = props.state === 'pending'
	const displayedText = pending && !props.keepTextWhilePending ? props.pendingText : props.text
	return (
		<button
			type = { props.type ?? 'button' }
			class = { props.class }
			style = { props.style }
			onClick = { props.onClick }
			disabled = { props.disabled || pending }
			aria-busy = { pending }
		>
			<PendingButtonContent pending = { pending } pendingIndicatorPlacement = { props.pendingIndicatorPlacement ?? 'inline' }>
				{ displayedText }
			</PendingButtonContent>
		</button>
	)
}
