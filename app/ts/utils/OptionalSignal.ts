import { Signal, batch, useSignalEffect } from '@preact/signals'
import { useMemo } from 'preact/hooks'

export interface OptionalSignal<T> {
	get value(): T | undefined
	set value(newValue: T | undefined)
	get deepValue(): T | undefined
	set deepValue(newValue: T | undefined)
	deepPeek(): T | undefined
	clear(): void
	set(newValue: T | undefined): void
}

export function OptionalSignal<T>(value: Signal<T> | T | undefined, startUndefined?: boolean): OptionalSignal<T> {
	const initialValue = value === undefined || startUndefined === true ? undefined : value instanceof Signal ? value : new Signal(value)
	const signal = new Signal<Signal<T> | undefined>(initialValue)
	let inner = initialValue

	const optionalSignal: OptionalSignal<T> = {
		get value() {
			return optionalSignal.deepValue
		},
		set value(newValue: T | undefined) {
			optionalSignal.deepValue = newValue
		},
		get deepValue() {
			const current = signal.value
			if (current === undefined) return undefined
			return current.value
		},
		set deepValue(newValue: T | undefined) {
			if (newValue === undefined) {
				signal.value = undefined
				return
			}

			batch(() => {
				if (inner === undefined) inner = new Signal(newValue)
				else inner.value = newValue
				signal.value = inner
			})
		},
		deepPeek() {
			const current = signal.peek()
			if (current === undefined) return undefined
			return current.peek()
		},
		clear() {
			signal.value = undefined
		},
		set(newValue: T | undefined) {
			optionalSignal.deepValue = newValue
		},
	}

	return optionalSignal
}

export function useOptionalSignal<T>(value: Signal<T> | T | undefined, startUndefined?: boolean) {
	return useMemo(() => OptionalSignal<T>(value, startUndefined), [])
}

export const useOptionalComputed = <T>(computeFn: () => T | undefined) => {
	const resultSignal = useOptionalSignal<T>(undefined)
	useSignalEffect(() => { resultSignal.deepValue = computeFn() })
	return resultSignal
}
