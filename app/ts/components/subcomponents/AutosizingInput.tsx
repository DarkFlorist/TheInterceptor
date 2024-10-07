import { JSX } from 'preact/jsx-runtime'
import { batch, Signal, useSignal, useSignalEffect } from '@preact/signals'
import { OptionalSignal } from '../../utils/OptionalSignal.js'

interface BaseInputModel extends Omit<JSX.HTMLAttributes<HTMLInputElement>, 'value' | 'onInput'> {
	readonly rawValue?: Signal<string>
}

interface UnparsedInputModel extends BaseInputModel {
	readonly value: Signal<string>
	readonly sanitize?: (input: string) => string
	readonly tryParse?: never
	readonly serialize?: never
}

interface ParsedInputModel<T> extends BaseInputModel {
	readonly value: OptionalSignal<T>
	readonly sanitize: (input: string) => string
	readonly tryParse: (input: string) => { ok: true, value: T | undefined } | { ok: false }
	readonly serialize: (input: T | undefined) => string
}

function ParsedInput<T>(model: ParsedInputModel<T>) {
	const pendingOnChange = useSignal(false)
	const internalValue = model.rawValue || useSignal(model.serialize(model.value.deepPeek()))

	// internalValue changed or signal/hook referenced by sanitize/tryParse changed
	useSignalEffect(() => {
		batch(() => {
			const sanitized = model.sanitize(internalValue.value)
			internalValue.value = sanitized
			const parsed = model.tryParse(sanitized)
			if (!parsed.ok) return
			if (parsed.value !== model.value.deepPeek()) pendingOnChange.value = true
			model.value.deepValue = parsed.value
		})
	})

	// model value changed or signal/hook referenced by sanitize/tryParse/serialize changed
	useSignalEffect(() => {
		batch(() => {
			const parsedInternal = model.tryParse(model.sanitize(internalValue.peek()))
			if (parsedInternal.ok && parsedInternal.value === model.value.deepValue) return
			internalValue.value = model.serialize(model.value.deepValue)
		})
	})

	function onChange(event: JSX.TargetedEvent<HTMLInputElement, Event>) {
		if (!pendingOnChange.peek()) return
		if (!model.onChange) return
		pendingOnChange.value = false
		model.onChange(event)
	}

	// we want to pass through all model values *except* the rawValue, which may contain a password
	const inputModel = { ...model }
	delete inputModel.rawValue
	return <input { ...inputModel } class = 'autosizing-input' value = { internalValue } onInput = { event => internalValue.value = event.currentTarget.value } onChange = { onChange }/>
}

function Input<T>(model: UnparsedInputModel | ParsedInputModel<T>) {
	if ('tryParse' in model && model.tryParse) {
		return <ParsedInput { ...model }/>
	} else {
		return <ParsedInput { ...model } value = { new OptionalSignal(model.value)} sanitize = { model.sanitize || (x => x) } tryParse = { value => ({ ok: true, value }) } serialize = { x => x || '' }/>
	}
}

interface BaseAutosizingInputModel extends Pick<JSX.HTMLAttributes<HTMLSpanElement>, 'class' | 'style'>, Pick<UnparsedInputModel, 'key' | 'type' | 'pattern' | 'placeholder' | 'required' | 'onChange' | 'autocomplete'> {
	readonly dataList?: string[]
	readonly rawValue?: Signal<string>
}
interface UnparsedAutosizingInputModel extends BaseAutosizingInputModel, Pick<UnparsedInputModel, 'value' | 'sanitize' | 'tryParse' | 'serialize'> {}
interface ParsedAutosizingInputModel<T> extends BaseAutosizingInputModel, Pick<ParsedInputModel<T>, 'value' | 'sanitize' | 'tryParse' | 'serialize'> {}

export function AutosizingInput<T>(model: UnparsedAutosizingInputModel | ParsedAutosizingInputModel<T>) {
	const internalValue = model.rawValue || useSignal(model.serialize ? model.serialize(model.value.deepPeek()) : model.value.peek())
	const inputModel = {
		rawValue: internalValue,
		type: model.type,
		pattern: model.pattern,
		required: model.required,
		placeholder: model.placeholder,
		autocomplete: model.autocomplete,
		onChange: model.onChange,
		list: 'datalist',
		size: 1,
		...model.serialize ? {
			value: model.value,
			sanitize: model.sanitize,
			tryParse: model.tryParse,
			serialize: model.serialize,
		} : {
			value: model.value,
			sanitize: model.sanitize,
		}
	} satisfies UnparsedInputModel | ParsedInputModel<T>
	return <span class = 'autosizing-span' style = { model.style } data-value = { model.placeholder }>
		<label class = 'autosizing-label' data-value = { internalValue.value }>
			<Input { ...inputModel }/>
		</label>
	</span>
}

const sanitizationRegexp = /[^\d]/g
const regexp = /^\d*$/

export interface IntegerInput {
	readonly value: OptionalSignal<bigint>
	readonly autoSize?: boolean
	readonly className?: string | JSX.SignalLike<string | undefined>
	readonly style?: string | JSX.CSSProperties | JSX.SignalLike<string | JSX.CSSProperties>
	readonly type?: string | JSX.SignalLike<string>
	readonly placeholder?: string | JSX.SignalLike<string>
	readonly required?: boolean | JSX.SignalLike<boolean>
	readonly dataList?: string[]
	readonly onChange?: () => void
}
export function IntegerInput(model: IntegerInput) {
	const properties = {
		value: model.value,
		pattern: regexp.source,
		sanitize: (input: string) => input.replaceAll(sanitizationRegexp, ''),
		tryParse: (input: string) => input === '' ? { ok: true, value: undefined } : regexp.test(input) ? { ok: true, value: BigInt(input) } : { ok: false } as const,
		serialize: (input: bigint | undefined) => input === undefined ? '' : input.toString(10),
		onChange: model.onChange,
		...model.className ? { className: model.className } : {},
		...model.style ? { style: model.style } : {},
		...model.type ? { type: model.type } : {},
		...model.placeholder ? { placeholder: model.placeholder } : {},
		...model.required ? { required: model.required } : {},
		...model.dataList ? { dataList: model.dataList } : {},
	} satisfies (UnparsedInputModel & UnparsedAutosizingInputModel) | (ParsedAutosizingInputModel<bigint> & ParsedInputModel<bigint>)
	return model.autoSize ? <AutosizingInput { ...properties }  /> : <Input { ...properties }/>
}
