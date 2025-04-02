import { Signal, useSignal } from '@preact/signals'
import { useRef } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'

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

	return <div ref = { ref } class = { `dropdown ${ isOpen.value ? 'is-active' : '' }` }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button className = { buttonClassses } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { toggle } title = { selected.value } style = { { width: '100%', columnGap: '0.5em' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ selected.value }</span>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset' } }>
			<div class = 'dropdown-content'> {
				dropDownOptions.value.map((option) => <>
					<button type = { buttonClassses } class = { `dropdown-item ${ option === selected.value ? 'is-active' : '' }` } onClick = { () => onChanged(option) } >
						{ option }
					</button>
				</>)
			} </div>
		</div>
	</div>
}
