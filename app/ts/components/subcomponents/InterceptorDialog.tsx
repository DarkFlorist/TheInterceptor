import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { XMarkIcon } from './icons.js'

type DialogSize = 'compact' | 'regular' | 'large'
const tabbableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function getDialogTabStops(dialog: HTMLDivElement) {
	return Array.from(dialog.querySelectorAll<HTMLElement>(tabbableSelector)).filter((element) => element.closest('[inert], [aria-hidden="true"]') === null)
}

type InterceptorDialogSurfaceProps = {
	ariaLabel: string
	children: ComponentChildren
	class?: string
	closeDisabled?: boolean
	fill?: boolean
	onBackdropClick?: () => void
	onClose?: () => void
	size?: DialogSize
}


export function InterceptorDialogSurface({ ariaLabel, children, class: className, closeDisabled = false, fill = false, onBackdropClick, onClose, size = 'regular' }: InterceptorDialogSurfaceProps) {
	const dialogRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const dialog = dialogRef.current
		if (dialog === null) return
		const previouslyFocused = document.activeElement
		if (!dialog.contains(previouslyFocused)) dialog.focus()
		return () => {
			if (previouslyFocused?.isConnected && 'focus' in previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus()
		}
	}, [])

	return <>
		<div class = 'modal-background interceptor-dialog-backdrop' onClick = { onBackdropClick }/>
		<div
			class = { `modal-card interceptor-dialog interceptor-dialog--${ size }${ fill ? ' interceptor-dialog--fill' : '' }${ className === undefined ? '' : ` ${ className }` }` }
			role = 'dialog'
			aria-modal = 'true'
			aria-label = { ariaLabel }
			ref = { dialogRef }
			tabIndex = { -1 }
			onKeyDown = { event => {
				if (event.key === 'Escape') {
					if (onClose === undefined || closeDisabled) return
					event.stopPropagation()
					onClose()
					return
				}
				if (event.key !== 'Tab') return
				const tabStops = getDialogTabStops(event.currentTarget)
				const first = tabStops[0]
				const last = tabStops[tabStops.length - 1]
				if (first === undefined || last === undefined) {
					event.preventDefault()
					event.currentTarget.focus()
					return
				}
				const activeElement = document.activeElement
				if (event.shiftKey && (activeElement === first || !event.currentTarget.contains(activeElement))) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && (activeElement === last || !event.currentTarget.contains(activeElement) || activeElement === event.currentTarget)) {
					event.preventDefault()
					first.focus()
				}
			} }
		>
			{ children }
		</div>
	</>
}

type InterceptorDialogHeaderProps = {
	accessory?: ComponentChildren
	close: () => void
	closeDisabled?: boolean
	closeLabel?: string
	icon: string
	iconContent?: ComponentChildren
	subtitle?: string
	title: string
}

export function InterceptorDialogHeader({ accessory, close, closeDisabled = false, closeLabel = 'Close dialog', icon, iconContent, subtitle, title }: InterceptorDialogHeaderProps) {
	return <header class = 'modal-card-head interceptor-dialog-header'>
		<span class = 'interceptor-dialog-icon' aria-hidden = 'true'>{ iconContent ?? <img src = { icon } width = '18' height = '18'/> }</span>
		<div class = 'interceptor-dialog-heading'>
			<p class = 'interceptor-dialog-title'>{ title }</p>
			{ subtitle === undefined ? <></> : <p class = 'interceptor-dialog-subtitle'>{ subtitle }</p> }
		</div>
		{ accessory === undefined ? <></> : <div class = 'interceptor-dialog-header-accessory'>{ accessory }</div> }
		<button type = 'button' class = 'interceptor-dialog-close' aria-label = { closeLabel } onClick = { close } disabled = { closeDisabled }><XMarkIcon/></button>
	</header>
}

type InterceptorDialogSectionProps = {
	children: ComponentChildren
	class?: string
	label?: string
}

export function InterceptorDialogSection({ children, class: className, label }: InterceptorDialogSectionProps) {
	return <section class = { `interceptor-dialog-section${ className === undefined ? '' : ` ${ className }` }` } aria-label = { label }>{ children }</section>
}

type InterceptorDialogBodyProps = {
	ariaHidden?: 'true'
	children: ComponentChildren
	class?: string
	inert?: boolean
}

export function InterceptorDialogBody({ ariaHidden, children, class: className, inert = false }: InterceptorDialogBodyProps) {
	return <section class = { `modal-card-body interceptor-dialog-body${ className === undefined ? '' : ` ${ className }` }` } aria-hidden = { ariaHidden } inert = { inert }>{ children }</section>
}

type InterceptorDialogFooterProps = {
	ariaHidden?: 'true'
	children: ComponentChildren
	class?: string
	inert?: boolean
}

export function InterceptorDialogFooter({ ariaHidden, children, class: className, inert = false }: InterceptorDialogFooterProps) {
	return <footer class = { `modal-card-foot interceptor-dialog-footer${ className === undefined ? '' : ` ${ className }` }` } aria-hidden = { ariaHidden } inert = { inert }>{ children }</footer>
}
