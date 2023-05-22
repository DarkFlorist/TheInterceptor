import { Signal, useSignal } from '@preact/signals'
export type Inactive = { state: 'inactive' }
export type Pending = { state: 'pending' }
export type Resolved<T> = { state: 'resolved', value: T }
export type Rejected = { state: 'rejected', error: Error }
export type AsyncProperty<T> = Inactive | Pending | Resolved<T> | Rejected
export type AsyncState<T> = { value: Signal<AsyncProperty<T>>, waitFor: (resolver: () => Promise<T>) => void, reset: () => void }

export function useAsyncState<T>(): AsyncState<T> {
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
			const result = capture.result
			if (result === undefined) return
			result.value = newResult
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
		const result = getCaptureAndCancelOthers().result
		if (result === undefined) return
		result.value = { state: 'inactive' }
	}

	const result = useSignal<AsyncProperty<T>>({ state: 'inactive' })
	const captureContainer = useSignal<{ result?: Signal<AsyncProperty<T>> }>({})

	return { value: result, waitFor: resolver => activate(resolver), reset }
}
