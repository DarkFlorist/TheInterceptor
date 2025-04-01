import { Signal, useSignal } from '@preact/signals'
import { clickOutsideAlerter } from '../ui-utils.js'
import { useRef } from 'preact/hooks'

export type DeltaUnit = 'Seconds' | 'Minutes' | 'Hours' | 'Days' | 'Weeks' | 'Years'
export type TimePickerMode = 'From' | 'Increment'

type TimePickerParams = {
	mode: Signal<TimePickerMode>
	absoluteTime: Signal<string>
	deltaValue: Signal<number>
	deltaUnit: Signal<DeltaUnit>
	onChange: (value: string) => void
	startText: string | undefined
}

export const TimePicker = ({ mode, absoluteTime, deltaValue, deltaUnit, onChange, startText }: TimePickerParams) => {
	const absoluteDeltaSwitchIsOpen = useSignal(false)
	const absoluteDeltaSwitchRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(absoluteDeltaSwitchRef, () => { absoluteDeltaSwitchIsOpen.value = false })

	const deltaUnitSwitchIsOpen = useSignal(false)
	const deltaUnitSwitchRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(deltaUnitSwitchRef, () => { deltaUnitSwitchIsOpen.value = false })

	const handleChange = () => {
		onChange('change!')
		/*if (mode.value === 'Set to') {
			onChange(absoluteTime.value)
		} else {
			onChange(`+ ${ deltaValue.value } ${ deltaUnit.value }`)
		}*/
	}

	const dropDownOptions = ['From', 'Increment'] as const
	const dropDownOptionsDelta = ['Seconds', 'Minutes', 'Hours', 'Days', 'Weeks', 'Years'] as const

	const changeMode = (newMode: TimePickerMode) => {
		mode.value = newMode
		absoluteDeltaSwitchIsOpen.value = false
	}
	const changeDeltaUnit = (newMode: DeltaUnit) => {
		deltaUnit.value = newMode
		deltaUnitSwitchIsOpen.value = false
	}

	return <div>
		<div style = 'display: flex; justify-content: space-between'>
			{ startText === undefined ? <></> : <p class = 'paragraph' style = 'align-content: center;'> { startText } </p> }
			<div style = 'display: grid; grid-template-columns: auto auto; column-gap: 10px;'>
				<div ref = { absoluteDeltaSwitchRef } class = { `dropdown ${ absoluteDeltaSwitchIsOpen.value ? 'is-active' : '' }` }>
					<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
						<button className = { 'btn btn--outline is-reveal is-small' } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => { absoluteDeltaSwitchIsOpen.value = !absoluteDeltaSwitchIsOpen.value } } title = { mode } style = { { width: '100%', columnGap: '0.5em' } }>
							<span class = 'truncate' style = { { contain: 'content' } }>{ mode.value }</span>
						</button>
					</div>
					<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset', top: '40px' } }>
						<div class = 'dropdown-content' style = { { position: 'fixed' } }> {
							dropDownOptions.map((option) => <>
								<button type = 'btn btn--outline is-small' class = { `dropdown-item ${ option === mode.value ? 'is-active' : '' }` } onClick = { () => changeMode(option) } >
									{ option }
								</button>
							</>)
						} </div>
					</div>
				</div>

				{ mode.value === 'From' ? (
					<input type = 'datetime-local' class = 'datetime' value = { absoluteTime.value } onInput = { e => { absoluteTime.value = e.currentTarget.value ; handleChange() } } />
				) : (
					<div>
						<input class = 'input' style = 'width: 50px; margin-right: 10px; vertical-align: unset; text-align: center;' type = 'number' value = { deltaValue.value } onInput = { (event) => { deltaValue.value = parseInt(event.currentTarget.value) || 0; handleChange() } } />

						<div ref = { deltaUnitSwitchRef } class = { `dropdown ${ deltaUnitSwitchIsOpen.value ? 'is-active' : '' }` }>
							<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
								<button className = { 'btn btn--outline is-primary is-reveal is-small' } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => { deltaUnitSwitchIsOpen.value = !deltaUnitSwitchIsOpen.value } } title = { mode } style = { { width: '100%', columnGap: '0.5em' } }>
									<span class = 'truncate' style = { { contain: 'content' } }>{ deltaUnit.value }</span>
								</button>
							</div>
							<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset', top: '40px' } }>
								<div class = 'dropdown-content' style = { { position: 'fixed' } }> {
									dropDownOptionsDelta.map((option) => <>
										<button type = 'btn btn--outline is-small' class = { `dropdown-item ${ option === deltaUnit.value ? 'is-active' : '' }` } onClick = { () => changeDeltaUnit(option) } >
											{ option }
										</button>
									</>)
								} </div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	</div>
}
