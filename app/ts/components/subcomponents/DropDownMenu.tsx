import { Signal, useSignal } from '@preact/signals'
import { useRef } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { ChevronIcon } from './icons.js'

type DropDownMenuParams<OptionType> = {
	selected: Signal<OptionType>
	dropDownOptions: Signal<readonly OptionType[]>
	onChangedCallBack: (newValue: OptionType) => void
	buttonClassses: string
}

export const DropDownMenu = <OptionType extends string,>({ selected, dropDownOptions, onChangedCallBack, buttonClassses }: DropDownMenuParams<OptionType>) => {
	const isOpen = useSignal(false)
	const ref = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(ref, () => { isOpen.value = false })

	const toggle = () => { isOpen.value = !isOpen.value }

	const onChanged = (newValue: OptionType) => {
		isOpen.value = false
		onChangedCallBack(newValue)
	}

	return <div ref = { ref } class = { `menu-dropdown ${ isOpen.value ? 'is-open' : '' }` }>
		<div class = 'menu-dropdown__trigger' style = { { maxWidth: '100%' } }>
			<button className = { buttonClassses } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { toggle } title = { selected.value } style = { { width: '100%' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ selected.value }</span>
				<span class = 'menu-dropdown__chevron'><ChevronIcon /></span>
			</button>
		</div>
		<div class = 'menu-dropdown__menu' id = 'dropdown-menu' role = 'menu' style = { { right: '0' } }>
			<div class = 'menu-dropdown__content' style = { { right: '0' } }> {
				dropDownOptions.value.map((option) => <>
					<button type = { buttonClassses } class = { `menu-dropdown__item ${ option === selected.value ? 'is-open' : '' }` } onClick = { () => onChanged(option) } >
						{ option }
					</button>
				</>)
			} </div>
		</div>
	</div>
}
