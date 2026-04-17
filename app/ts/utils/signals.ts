import { Signal, type ReadonlySignal } from '@preact/signals'

export type SignalLike<T> = ReadonlySignal<T> | Signal<T>
export type SignalOrValue<T> = T | SignalLike<T>

export function resolveSignal<T>(value: SignalOrValue<T>) {
	return value instanceof Signal ? value.value : value
}
