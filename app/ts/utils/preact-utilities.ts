import { type Signal, useSignal } from '@preact/signals'
import { useEffect, useMemo, useRef } from 'preact/hooks'
type Inactive = { state: 'inactive' }
type Pending = { state: 'pending' }
type Resolved<T> = { state: 'resolved', value: T }
type Rejected = { state: 'rejected', error: Error }
type AsyncProperty<T> = Inactive | Pending | Resolved<T> | Rejected
type AsyncState<T> = { value: Signal<AsyncProperty<T>>, waitFor: (resolver: () => Promise<T>) => void, reset: () => void }
export type AsyncActionContext<T> = { value: Signal<AsyncProperty<T>>, waitFor: (resolver: () => Promise<T>) => void, reset: () => void }
export type AsyncStates = AsyncState<unknown>['value']['value']['state']

export function createAsyncActionRunner<T>(asyncAction: AsyncActionContext<T>, resolver: () => Promise<T>) {
	return () => { void asyncAction.waitFor(resolver) }
}

export function useAsyncState<T>(): AsyncState<T> {
	const result = useSignal<AsyncProperty<T>>({ state: 'inactive' })
	const captureContainer = useSignal<{ result?: Signal<AsyncProperty<T>> }>({})

	// The returned functions only touch the two signals above, so they are created once and keep a stable identity that callers can list as effect dependencies.
	return useMemo(() => {
		function getCaptureAndCancelOthers() {
			// delete previously captured signal so any pending async work will no-op when they resolve
			delete captureContainer.peek().result
			// capture the signal in a new object so we can delete it later if it is interrupted
			captureContainer.value = { result }
			return captureContainer.peek()
		}

		async function activate(resolver: () => Promise<T>) {
			const capture = getCaptureAndCancelOthers()
			// we need to read the property out of the capture every time we look at it, in case it is deleted asynchronously
			function setCapturedResult(newResult: AsyncProperty<T>) {
				const capturedResult = capture.result
				if (capturedResult === undefined) return
				capturedResult.value = newResult
			}
			try {
				const pendingState = { state: 'pending' as const }
				setCapturedResult(pendingState)
				const resolvedValue = await resolver()
				const resolvedState = { state: 'resolved' as const, value: resolvedValue }
				setCapturedResult(resolvedState)
			} catch (unknownError: unknown) {
				const error = unknownError instanceof Error ? unknownError : typeof unknownError === 'string' ? new Error(unknownError) : new Error(`Unknown error occurred.\n${ JSON.stringify(unknownError) }`)
				const rejectedState = { state: 'rejected' as const, error }
				setCapturedResult(rejectedState)
			}
		}

		function reset() {
			const capturedResult = getCaptureAndCancelOthers().result
			if (capturedResult === undefined) return
			capturedResult.value = { state: 'inactive' }
		}

		return { value: result, waitFor: (resolver: () => Promise<T>) => activate(resolver), reset }
	}, [])
}

function haveSameEntries(left: readonly unknown[], right: readonly unknown[]) {
	return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Runs `effect` after the first render and after every later render in which an entry of `watchedValues` changed (compared with Object.is, like hook dependencies).
 * `effect` itself is deliberately not a trigger: each run uses the newest closure, so it can read current props and callbacks without restarting whenever the parent passes new function or object identities.
 * Use it to reset or restart local work when the identity of what a component shows changes. It does not support cleanup functions.
 */
export function useEffectWhenValuesChange(watchedValues: readonly unknown[], effect: () => void) {
	const lastWatchedValues = useRef<readonly unknown[] | undefined>(undefined)
	useEffect(() => {
		const previousWatchedValues = lastWatchedValues.current
		if (previousWatchedValues !== undefined && haveSameEntries(previousWatchedValues, watchedValues)) return
		lastWatchedValues.current = watchedValues
		effect()
	}, [watchedValues, effect])
}
