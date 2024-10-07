import { ReadonlySignal, Signal, batch } from '@preact/signals'
import { useMemo } from 'preact/hooks'

export class OptionalSignal<T> extends Signal<Signal<T> | undefined> implements ReadonlySignal<Signal<T> | undefined> {
	private inner: Signal<T> | undefined

	public constructor(value: Signal<T> | T | undefined, startUndefined?: boolean) {
		super(value === undefined || startUndefined === true ? undefined : value instanceof Signal ? value : new Signal(value))
		this.set = this.set.bind(this)
		if (this.value instanceof Signal) this.inner = this.value
	}

	public get deepValue() {
		const inner = this.value
		if (inner === undefined) return undefined
		else return inner.value
	}

	public set deepValue(newValue: T | undefined) {
		if (newValue === undefined) {
			this.value = undefined
		} else {
			batch(() => {
				if (this.inner === undefined) this.inner = new Signal(newValue)
				else this.inner.value = newValue
				this.value = this.inner
			})
		}
	}

	public readonly deepPeek = () => {
		const inner = this.peek()
		if (inner === undefined) return undefined
		else return inner.peek()
	}

	public readonly clear = () => this.value = undefined

	// convenience function for when you want pass a setter to a function; note that this is `this` bound in the constructor
	public set(newValue: T | undefined) { this.deepValue = newValue }
}

export function useOptionalSignal<T>(value: Signal<T> | T | undefined, startUndefined?: boolean) {
	return useMemo(() => new OptionalSignal<T>(value, startUndefined), [])
}
