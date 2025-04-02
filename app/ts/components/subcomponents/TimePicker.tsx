import { Signal, useSignal } from '@preact/signals'
import { DropDownMenu } from './DropDownMenu.js'
import { JSX } from 'preact/jsx-runtime'
import { assertNever } from '../../utils/typescript.js'

const timePickerModeDownOptions = ['Until', 'For', 'No Delay'] as const
const timePickerModeDownOptionsWithoutNoDelay = ['Until', 'For'] as const
const timePickerDeltaOptions = ['Seconds', 'Minutes', 'Hours', 'Days', 'Weeks', 'Years'] as const

export type DeltaUnit = typeof timePickerDeltaOptions[number]
export type TimePickerMode = typeof timePickerModeDownOptions[number]

type TimePickerModeViewsParams = {
	mode: Signal<TimePickerMode>
	absoluteTime: Signal<string>
	deltaValue: Signal<number>
	deltaUnit: Signal<DeltaUnit>

	timePickerDeltaOptionsSignal: Signal<readonly DeltaUnit[]>

	changeDeltaUnit: (newOption: DeltaUnit) => void
	absoluteTimeChanged: (event: JSX.TargetedInputEvent<HTMLInputElement>) => void
	changeDeltaValue: (event: JSX.TargetedInputEvent<HTMLInputElement>) => void
}

const TimePickerModeViews = ({ mode, absoluteTime, timePickerDeltaOptionsSignal, deltaValue, deltaUnit, changeDeltaUnit, absoluteTimeChanged, changeDeltaValue }: TimePickerModeViewsParams) => {
	switch(mode.value) {
		case 'No Delay': return <></>
		case 'Until': return <input type = 'datetime-local' class = 'datetime' value = { absoluteTime.value } onInput = { absoluteTimeChanged } />
		case 'For': return <div>
			<input class = 'input' style = 'width: 50px; margin-right: 10px; vertical-align: unset; text-align: center;' type = 'number' value = { deltaValue.value } onInput = { changeDeltaValue } />
			<DropDownMenu selected = { deltaUnit } dropDownOptions = { timePickerDeltaOptionsSignal } onChangedCallBack = { changeDeltaUnit } buttonClassses = { 'btn btn--outline is-small' }/>
		</div>
		default: assertNever(mode.value)
	}
}

type TimePickerParams = {
	mode: Signal<TimePickerMode>
	absoluteTime: Signal<string>
	deltaValue: Signal<number>
	deltaUnit: Signal<DeltaUnit>
	onChangedCallBack: () => void
	startText: string
	removeNoDelayOption: boolean
}

export const TimePicker = ({ mode, absoluteTime, deltaValue, deltaUnit, onChangedCallBack, startText, removeNoDelayOption }: TimePickerParams) => {
	const timePickerModeDownOptionsSignal = useSignal<readonly TimePickerMode[]>(removeNoDelayOption ? timePickerModeDownOptionsWithoutNoDelay : timePickerModeDownOptions)
	const timePickerDeltaOptionsSignal = useSignal<readonly DeltaUnit[]>(timePickerDeltaOptions)

	const changeMode = (newOption: TimePickerMode) => {
		mode.value = newOption
		onChangedCallBack()
	}
	const changeDeltaUnit = (newOption: DeltaUnit) => {
		deltaUnit.value = newOption
		onChangedCallBack()
	}
	const absoluteTimeChanged = (event: JSX.TargetedInputEvent<HTMLInputElement>) => {
		absoluteTime.value = event.currentTarget.value;
		onChangedCallBack()
	}
	const changeDeltaValue = (event: JSX.TargetedInputEvent<HTMLInputElement>) => {
		deltaValue.value = parseInt(event.currentTarget.value) || deltaValue.value
		onChangedCallBack()
	}

	return <div>
		<div style = 'display: flex; justify-content: space-between'>
			<p class = 'paragraph' style = 'align-content: center;'> { startText } </p>
			<div style = 'display: grid; grid-template-columns: auto auto; column-gap: 10px; padding-left: 5px'>
				<DropDownMenu selected = { mode } dropDownOptions = { timePickerModeDownOptionsSignal } onChangedCallBack = { changeMode } buttonClassses = { 'btn btn--outline is-small' }/>
				<TimePickerModeViews mode = { mode } absoluteTime = { absoluteTime } deltaValue = { deltaValue } deltaUnit = { deltaUnit } timePickerDeltaOptionsSignal = { timePickerDeltaOptionsSignal } changeDeltaUnit = { changeDeltaUnit } absoluteTimeChanged = { absoluteTimeChanged } changeDeltaValue = { changeDeltaValue }/>
			</div>
		</div>
	</div>
}
