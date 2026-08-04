import { type Signal, useSignal } from '@preact/signals'
import { useId, useRef } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { ChevronIcon } from './icons.js'
import type { ComponentChildren } from 'preact'

type DropDownMenuParams<OptionType> = {
	selected: Signal<OptionType>
	dropDownOptions: Signal<readonly OptionType[]>
	onChangedCallBack: (newValue: OptionType) => void
	buttonClassses: string
	ariaLabel?: string
	disabled?: boolean
	getOptionLabel?: (option: OptionType) => string
	renderOption?: (option: OptionType) => ComponentChildren
}

export function DropDownMenuButtonContent({ label }: { label: ComponentChildren }) {
	return <>
		<span class = 'truncate' style = { { contain: 'content' } }>{ label }</span>
		<span class = 'dropdown-chevron'><ChevronIcon /></span>
	</>
}

export const DropDownMenu = <OptionType extends string,>({ selected, dropDownOptions, onChangedCallBack, buttonClassses, ariaLabel, disabled = false, getOptionLabel = (option) => option, renderOption = getOptionLabel }: DropDownMenuParams<OptionType>) => {
	const isOpen = useSignal(false)
	const ref = useRef<HTMLDivElement>(null)
	const menuId = useId()
	clickOutsideAlerter(ref, () => { isOpen.value = false })

	const toggle = () => {
		if (disabled) return
		isOpen.value = !isOpen.value
	}

	const onChanged = (newValue: OptionType) => {
		if (disabled) return
		isOpen.value = false
		onChangedCallBack(newValue)
	}

	return <div ref = { ref } class = { `dropdown ${ isOpen.value ? 'is-active' : '' }` }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button type = 'button' class = { buttonClassses } disabled = { disabled } aria-label = { ariaLabel === undefined ? undefined : `${ ariaLabel }: ${ getOptionLabel(selected.value) }` } aria-haspopup = 'true' aria-expanded = { isOpen.value } aria-controls = { menuId } onClick = { toggle } title = { getOptionLabel(selected.value) } style = { { width: '100%' } }>
				<DropDownMenuButtonContent label = { renderOption(selected.value) }/>
			</button>
		</div>
		<div class = 'dropdown-menu' id = { menuId } role = 'menu' style = { { right: '0' } }>
			<div class = 'dropdown-content' style = { { right: '0' } }> {
				dropDownOptions.value.map((option, index) =>
					<button key = { `${ option }-${ index }` } type = 'button' class = { `dropdown-item ${ option === selected.value ? 'is-active' : '' }` } onClick = { () => onChanged(option) } >
						{ renderOption(option) }
					</button>
				)
			} </div>
		</div>
	</div>
}
