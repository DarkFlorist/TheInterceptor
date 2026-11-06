import { type ReadonlySignal, useSignal } from '@preact/signals'
import { useId, useRef } from 'preact/hooks'
import { clickOutsideAlerter, scheduleAfterPaint } from '../ui-utils.js'
import { AsyncStatusIcon } from './AsyncAction.js'
import { ChevronIcon } from './icons.js'
import type { ComponentChildren, JSX } from 'preact'

type DropDownMenuParams<OptionType> = {
	selected: ReadonlySignal<OptionType | undefined>
	dropDownOptions: ReadonlySignal<readonly OptionType[]>
	onChangedCallBack: (newValue: OptionType) => void
	buttonClassses: string
	ariaLabel?: string
	disabled?: boolean
	pendingText?: string
	getOptionLabel?: (option: OptionType) => string
	renderOption?: (option: OptionType, selected: boolean) => ComponentChildren
	renderSelected?: (option: OptionType | undefined) => ComponentChildren
	getOptionKey?: (option: OptionType) => string
	getOptionAttributes?: (option: OptionType) => { readonly [key: `data-${string}`]: string }
	placeholder?: string
	id?: string
	optionsId?: string
	optionMounting?: 'persistent' | 'when-open'
	triggerLayout?: 'label' | 'custom'
	classes?: { readonly trigger?: string, readonly container: string, readonly menu: string, readonly content: string, readonly option: string, readonly chevron: string }

}

export function DropDownMenuButtonContent({ label, pendingText }: { label: ComponentChildren, pendingText?: string }) {
	return <>
		<span class = 'truncate' style = { { contain: 'content' } }>{ label }</span>
		<span class = 'dropdown-chevron' aria-hidden = 'true' title = { pendingText }>{ pendingText === undefined ? <ChevronIcon /> : <AsyncStatusIcon state = 'pending' size = '1rem' /> }</span>
	</>
}

// This choice control uses listbox semantics for both string and object options; mounting and trigger layout are explicit, independent of styling.
export const DropDownMenu = <OptionType,>({ selected, dropDownOptions, onChangedCallBack, buttonClassses, ariaLabel, disabled = false, pendingText, getOptionLabel = String, renderOption = getOptionLabel, renderSelected, getOptionKey = String, getOptionAttributes, placeholder = '', id, optionsId, optionMounting = 'persistent', triggerLayout = 'label', classes }: DropDownMenuParams<OptionType>) => {
	const unavailable = disabled || pendingText !== undefined
	const isOpen = useSignal(false)
	const ref = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const optionRefs = useRef(new Map<string, HTMLButtonElement>())
	const renderedOptions = () => dropDownOptions.value.map((option) => optionRefs.current.get(getOptionKey(option))).filter((option): option is HTMLButtonElement => option !== undefined)
	const generatedMenuId = useId()
	const menuId = optionsId ?? generatedMenuId
	clickOutsideAlerter(ref, () => { isOpen.value = false })
	const isSelected = (option: OptionType) => selected.value !== undefined && getOptionKey(option) === getOptionKey(selected.value)
	const label = selected.value === undefined ? placeholder : getOptionLabel(selected.value)
	const focusOption = (last = false) => {
		// Wait for Preact to render the newly opened list before querying its buttons.
		scheduleAfterPaint(() => {
			if (!isOpen.value) return
			const options = renderedOptions()
			const option = last ? options[options.length - 1] : options.find((candidate) => candidate.getAttribute('aria-selected') === 'true') ?? options[0]
			option?.focus()
		})
	}
	const open = (last = false) => {
		if (unavailable) return
		isOpen.value = true
		focusOption(last)
	}
	const onChanged = (newValue: OptionType) => {
		if (unavailable) return
		isOpen.value = false
		triggerRef.current?.focus()
		onChangedCallBack(newValue)
	}
	const onTriggerKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
		event.preventDefault()
		open(event.key === 'ArrowUp' && selected.value === undefined)
	}
	const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			isOpen.value = false
			triggerRef.current?.focus()
			return
		}
		if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute('role') !== 'option') return
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			event.target.click()
			return
		}
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
		event.preventDefault()
		const options = renderedOptions()
		const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (options.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
		options[index]?.focus()
	}
	const onFocusOut = (event: JSX.TargetedFocusEvent<HTMLDivElement>) => {
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
		isOpen.value = false
	}
	return <div ref = { ref } class = { classes?.container ?? `dropdown ${ isOpen.value ? 'is-active' : '' }` } onFocusOut = { onFocusOut } onKeyDown = { onKeyDown }>
		<div class = { classes?.trigger ?? 'dropdown-trigger' } style = { { maxWidth: '100%' } }>
			<button ref = { triggerRef } id = { id } type = 'button' class = { buttonClassses } disabled = { unavailable } aria-busy = { pendingText !== undefined } aria-label = { ariaLabel === undefined ? undefined : `${ ariaLabel }: ${ label }` } aria-haspopup = 'listbox' aria-expanded = { isOpen.value } aria-controls = { menuId } onClick = { () => { if (isOpen.value) isOpen.value = false; else open() } } onKeyDown = { onTriggerKeyDown } title = { label } style = { { width: '100%' } }>
				{ triggerLayout === 'label'
					? <DropDownMenuButtonContent label = { renderSelected?.(selected.value) ?? (selected.value === undefined ? placeholder : renderOption(selected.value, true)) } pendingText = { pendingText }/>
					: <>{ renderSelected?.(selected.value) ?? (selected.value === undefined ? placeholder : renderOption(selected.value, true)) }<span class = { classes?.chevron ?? 'dropdown-chevron' } aria-hidden = 'true'><ChevronIcon /></span></> }
			</button>
			<span class = 'dropdown-status-text' role = 'status' aria-live = 'polite' aria-atomic = 'true'>{ pendingText }</span>
		</div>
		{ isOpen.value || optionMounting === 'persistent' ? <div aria-hidden = { !isOpen.value } class = { classes?.menu ?? 'dropdown-menu' } id = { menuId } role = 'listbox' aria-label = { ariaLabel } style = { { right: '0', display: isOpen.value ? undefined : 'none' } }>
			<div class = { classes?.content ?? 'dropdown-content' } style = { { right: '0' } }> {
				dropDownOptions.value.map((option, index) =>
					<button ref = { (element) => { if (element === null) optionRefs.current.delete(getOptionKey(option)); else optionRefs.current.set(getOptionKey(option), element) } } key = { getOptionKey(option) } type = 'button' class = { `${ classes?.option ?? 'dropdown-item' } ${ isSelected(option) ? 'is-active is-selected' : '' }` } role = 'option' aria-selected = { isSelected(option) } aria-label = { getOptionLabel(option) } title = { getOptionLabel(option) } tabIndex = { isSelected(option) || (selected.value === undefined && index === 0) ? 0 : -1 } { ...getOptionAttributes?.(option) } onClick = { () => onChanged(option) }>
						{ renderOption(option, isSelected(option)) }
					</button>
				)
			} </div>
		</div> : <></> }
	</div>
}
