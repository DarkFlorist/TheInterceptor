import { Signal, type ReadonlySignal } from '@preact/signals'

export type SignalLike<T> = ReadonlySignal<T> | Signal<T>
export type SignalOrValue<T> = T | SignalLike<T>

function isSignalLike<T>(value: SignalOrValue<T>): value is SignalLike<T> {
	return value instanceof Signal
}

export function resolveSignal<T>(value: SignalOrValue<T>): T {
	return isSignalLike(value) ? value.value : value
}
