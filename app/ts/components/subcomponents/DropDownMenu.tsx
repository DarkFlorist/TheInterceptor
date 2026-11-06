import { type Signal, useSignal } from '@preact/signals'
import { useId, useRef } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { AsyncStatusIcon } from './AsyncAction.js'
import { ChevronIcon } from './icons.js'
import type { ComponentChildren } from 'preact'

type DropDownMenuParams<OptionType> = {
	selected: Signal<OptionType>
	dropDownOptions: Signal<readonly OptionType[]>
	onChangedCallBack: (newValue: OptionType) => void
	buttonClassses: string
	ariaLabel?: string
	disabled?: boolean
	pendingText?: string
	getOptionLabel?: (option: OptionType) => string
	renderOption?: (option: OptionType) => ComponentChildren
}

export function DropDownMenuButtonContent({ label, pendingText }: { label: ComponentChildren, pendingText?: string }) {
	return <>
		<span class = 'truncate dropdown-button-label'>{ label }</span>
		<span class = 'dropdown-chevron' aria-hidden = 'true' title = { pendingText }>{ pendingText === undefined ? <ChevronIcon /> : <AsyncStatusIcon state = 'pending' size = '1rem' /> }</span>
	</>
}

export const DropDownMenu = <OptionType extends string,>({ selected, dropDownOptions, onChangedCallBack, buttonClassses, ariaLabel, disabled = false, pendingText, getOptionLabel = (option) => option, renderOption = getOptionLabel }: DropDownMenuParams<OptionType>) => {
	const unavailable = disabled || pendingText !== undefined
	const isOpen = useSignal(false)
	const ref = useRef<HTMLDivElement>(null)
	const menuId = useId()
	clickOutsideAlerter(ref, () => { isOpen.value = false })

	const toggle = () => {
		if (unavailable) return
		isOpen.value = !isOpen.value
	}

	const onChanged = (newValue: OptionType) => {
		if (unavailable) return
		isOpen.value = false
		onChangedCallBack(newValue)
	}

	return <div ref = { ref } class = { `dropdown ${ isOpen.value ? 'is-active' : '' }` }>
		<div class = 'dropdown-trigger'>
			<button type = 'button' class = { `${ buttonClassses } dropdown-trigger-button` } disabled = { unavailable } aria-busy = { pendingText !== undefined } aria-label = { ariaLabel === undefined ? undefined : `${ ariaLabel }: ${ getOptionLabel(selected.value) }` } aria-haspopup = 'true' aria-expanded = { isOpen.value } aria-controls = { menuId } onClick = { toggle } title = { getOptionLabel(selected.value) }>
				<DropDownMenuButtonContent label = { renderOption(selected.value) } pendingText = { pendingText }/>
			</button>
			<span class = 'dropdown-status-text' role = 'status' aria-live = 'polite' aria-atomic = 'true'>{ pendingText }</span>
		</div>
		<div class = 'dropdown-menu' id = { menuId } role = 'menu'>
			<div class = 'dropdown-content'> {
				dropDownOptions.value.map((option, index) =>
					<button key = { `${ option }-${ index }` } type = 'button' class = { `dropdown-item ${ option === selected.value ? 'is-active' : '' }` } onClick = { () => onChanged(option) } >
						{ renderOption(option) }
					</button>
				)
			} </div>
		</div>
	</div>
}
