import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { DropDownMenu } from './DropDownMenu.js'
import { JSX } from 'preact/jsx-runtime'
import { assertNever } from '../../utils/typescript.js'
import { dateToBigintSeconds } from '../../utils/bigint.js'

const timePickerModeDownOptions = ['Until', 'For', 'No Delay'] as const
const timePickerModeDownOptionsWithoutNoDelay = ['Until', 'For'] as const
const timePickerDeltaOptions = ['Seconds', 'Minutes', 'Hours', 'Days', 'Weeks', 'Months', 'Years'] as const

export type DeltaUnit = typeof timePickerDeltaOptions[number]
export type TimePickerMode = typeof timePickerModeDownOptions[number]

export const getTimeManipulatorFromSignals = (timeSelectorMode: TimePickerMode, timeSelectorAbsoluteTime: Date | undefined, timeSelectorDeltaValue: bigint, timeSelectorDeltaUnit: DeltaUnit) => {
	switch(timeSelectorMode) {
		case 'No Delay': return { type: 'No Delay' } as const
		case 'For': return { type: 'AddToTimestamp', deltaToAdd: timeSelectorDeltaValue, deltaUnit: timeSelectorDeltaUnit } as const
		case 'Until': {
			if (timeSelectorAbsoluteTime === undefined) return { type: 'No Delay'} as const
			return { type: 'SetTimetamp', timeToSet: dateToBigintSeconds(timeSelectorAbsoluteTime) } as const
		}
		default: assertNever(timeSelectorMode)
	}
}

type TimePickerModeViewsParams = {
	mode: Signal<TimePickerMode>
	absoluteTime: Signal<Date | undefined>
	deltaValue: Signal<bigint>
	deltaUnit: Signal<DeltaUnit>

	timePickerDeltaOptionsSignal: Signal<readonly DeltaUnit[]>

	changeDeltaUnit: (newOption: DeltaUnit) => void
	absoluteTimeChanged: (event: JSX.TargetedInputEvent<HTMLInputElement>) => void
	changeDeltaValue: (event: JSX.TargetedInputEvent<HTMLInputElement>) => void
}

const TimePickerModeViews = ({ mode, absoluteTime, timePickerDeltaOptionsSignal, deltaValue, deltaUnit, changeDeltaUnit, absoluteTimeChanged, changeDeltaValue }: TimePickerModeViewsParams) => {
	switch(mode.value) {
		case 'No Delay': return <></>
		case 'Until': return <input type = 'datetime-local' class = 'datetime' value = { absoluteTime.value?.toISOString().slice(0, 19) } onInput = { absoluteTimeChanged } />
		case 'For': return <div>
			<input class = 'input' style = 'width: 50px; margin-right: 10px; vertical-align: unset; text-align: center;' type = 'number' value = { Number(deltaValue.value) } onInput = { changeDeltaValue } />
			<DropDownMenu selected = { deltaUnit } dropDownOptions = { timePickerDeltaOptionsSignal } onChangedCallBack = { changeDeltaUnit } buttonClassses = { 'btn btn--outline is-small' }/>
		</div>
		default: assertNever(mode.value)
	}
}

type TimePickerParams = {
	mode: Signal<TimePickerMode>
	absoluteTime: Signal<Date | undefined>
	deltaValue: Signal<bigint>
	deltaUnit: Signal<DeltaUnit>
	onChangedCallBack: () => void
	startText: string
	removeNoDelayOption: boolean
}

export const TimePicker = ({ mode, absoluteTime, deltaValue, deltaUnit, onChangedCallBack, startText, removeNoDelayOption }: TimePickerParams) => {
	const timePickerModeDownOptionsSignal = useSignal<readonly TimePickerMode[]>(removeNoDelayOption ? timePickerModeDownOptionsWithoutNoDelay : timePickerModeDownOptions)
	const timePickerDeltaOptionsSignal = useSignal<readonly DeltaUnit[]>(timePickerDeltaOptions)

	const temporaryMode = useSignal<'No Delay' | 'Until' | 'For'>(mode.value)
	const temporaryAbsoluteTime = useSignal<Date | undefined>(absoluteTime.value)
	const temporaryDeltaValue = useSignal<bigint>(deltaValue.value)
	const temporaryDeltaUnit = useSignal<'Seconds' | 'Minutes' | 'Hours' | 'Days' | 'Weeks' | 'Months' | 'Years'>(deltaUnit.value)

	useSignalEffect(() => {
		mode.value
		absoluteTime.value
		deltaValue.value
		deltaUnit.value

		const updateValues = () => {
			temporaryMode.value = mode.value
			temporaryDeltaUnit.value = deltaUnit.value
			temporaryAbsoluteTime.value = absoluteTime.value
			temporaryDeltaValue.value = deltaValue.value
		}
		updateValues()
	})

	const changeMode = (newOption: TimePickerMode) => {
		temporaryMode.value = newOption
	}
	const changeDeltaUnit = (newOption: DeltaUnit) => {
		temporaryDeltaUnit.value = newOption
	}
	const absoluteTimeChanged = (event: JSX.TargetedInputEvent<HTMLInputElement>) => {
		temporaryAbsoluteTime.value = new Date(Date.parse(event.currentTarget.value))
	}
	const changeDeltaValue = (event: JSX.TargetedInputEvent<HTMLInputElement>) => {
		temporaryDeltaValue.value = BigInt(parseInt(event.currentTarget.value) || deltaValue.value)
	}

	const hasValuesChanged = useComputed(() => {
		if (mode.value !== temporaryMode.value) return true
		if (mode.value === 'For') return deltaUnit.value !== temporaryDeltaUnit.value || deltaValue.value !== temporaryDeltaValue.value
		if (mode.value === 'Until') return absoluteTime.value !== temporaryAbsoluteTime.value
		return false
	})

	const commitOptions = () => {
		mode.value = temporaryMode.value
		deltaUnit.value = temporaryDeltaUnit.value
		absoluteTime.value = temporaryAbsoluteTime.value
		deltaValue.value = temporaryDeltaValue.value
		onChangedCallBack()
	}

	return <div>
		<div style = 'display: flex; justify-content: space-between'>
			<p class = 'paragraph' style = 'align-content: center;'> { startText } </p>
			<div style = 'display: grid; grid-template-columns: auto auto auto; column-gap: 10px; padding-left: 5px'>
				<DropDownMenu selected = { temporaryMode } dropDownOptions = { timePickerModeDownOptionsSignal } onChangedCallBack = { changeMode } buttonClassses = { 'btn btn--outline is-small' }/>
				<TimePickerModeViews mode = { temporaryMode } absoluteTime = { temporaryAbsoluteTime } deltaValue = { temporaryDeltaValue } deltaUnit = { temporaryDeltaUnit } timePickerDeltaOptionsSignal = { timePickerDeltaOptionsSignal } changeDeltaUnit = { changeDeltaUnit } absoluteTimeChanged = { absoluteTimeChanged } changeDeltaValue = { changeDeltaValue }/>

				<button class = 'btn btn--outline is-small' onClick = { commitOptions } style = { { visibility: hasValuesChanged.value ? 'visible' : 'hidden' } }>
					Commit
				</button>
			</div>
		</div>
	</div>
}
