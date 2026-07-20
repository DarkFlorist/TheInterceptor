import { type Signal, useSignal } from '@preact/signals'
import { useRef } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { ChevronIcon } from './icons.js'

type DropDownMenuParams<OptionType> = {
	selected: Signal<OptionType>
	dropDownOptions: Signal<readonly OptionType[]>
	onChangedCallBack: (newValue: OptionType) => void
	buttonClassses: string
	disabled?: boolean
}

export function DropDownMenuButtonContent({ label }: { label: string }) {
	return <>
		<span class = 'truncate' style = { { contain: 'content' } }>{ label }</span>
		<span class = 'dropdown-chevron'><ChevronIcon /></span>
	</>
}

export const DropDownMenu = <OptionType extends string,>({ selected, dropDownOptions, onChangedCallBack, buttonClassses, disabled = false }: DropDownMenuParams<OptionType>) => {
	const isOpen = useSignal(false)
	const ref = useRef<HTMLDivElement>(null)
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
			<button class = { buttonClassses } disabled = { disabled } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { toggle } title = { selected.value } style = { { width: '100%' } }>
				<DropDownMenuButtonContent label = { selected.value }/>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { right: '0' } }>
			<div class = 'dropdown-content' style = { { right: '0' } }> {
				dropDownOptions.value.map((option) => <>
					<button type = { buttonClassses } class = { `dropdown-item ${ option === selected.value ? 'is-active' : '' }` } onClick = { () => onChanged(option) } >
						{ option }
					</button>
				</>)
			} </div>
		</div>
	</div>
}
