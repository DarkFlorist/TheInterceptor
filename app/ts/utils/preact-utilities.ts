import * as preactHooks from 'preact/hooks'
export type Inactive = { state: 'inactive' }
export type Pending = { state: 'pending' }
export type Resolved<T> = { state: 'resolved', value: T }
export type Rejected = { state: 'rejected', error: Error }
export type AsyncProperty<T> = Inactive | Pending | Resolved<T> | Rejected

export function useAsyncState<T>(initialResolver?: () => Promise<T>): [AsyncProperty<T>, (resolver: () => Promise<T>) => void, () => void] {
	function getCaptureAndCancelOthers() {
		// set the previously captured functions to be no-ops
		captureContainer.previousCapture.setResult = () => {}
		// capture the functions we need in an object so we can use it after the await...
		const capture = { setResult }
		// ...and also store the captured functions in our container so we can turn them into no-ops later
		captureContainer.previousCapture = capture
		return capture
	}

	async function activate(resolver: () => Promise<T>) {
		const capture = getCaptureAndCancelOthers()
		try {
			const pendingState = { state: 'pending' as const }
			capture.setResult(pendingState)
			const resolvedValue = await resolver()
			const resolvedState = { state: 'resolved' as const, value: resolvedValue }
			capture.setResult(resolvedState)
		} catch (unknownError: unknown) {
			const error = unknownError instanceof Error ? unknownError : typeof unknownError === 'string' ? new Error(unknownError) : new Error(`Unknown error occurred.\n${JSON.stringify(unknownError)}`)
			const rejectedState = { state: 'rejected' as const, error }
			capture.setResult(rejectedState)
		}
	}

	function reset() {
		getCaptureAndCancelOthers().setResult({ state: 'inactive' })
	}

	const [ captureContainer ] = preactHooks.useState<{previousCapture: { setResult: preactHooks.StateUpdater<AsyncProperty<T>>}}>({previousCapture: { setResult: () => {} }})
	let firstRun = false
	const [ result, setResult ] = preactHooks.useState<AsyncProperty<T>>(() => { firstRun = true; return { state: 'inactive' } })
	if (firstRun && initialResolver !== undefined) activate(initialResolver)

	return [ result, resolver => activate(resolver), reset ]
}
