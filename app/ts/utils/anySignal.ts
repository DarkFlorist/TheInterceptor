/**
 * Returns an abort signal that is getting aborted when
 * at least one of the specified abort signals is aborted.
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
	const controller = new AbortController()
	for (const signal of signals) {
		if (signal.aborted) {
			// Exiting early if one of the signals
			// is already aborted.
			controller.abort(signal.reason)
			break
		}
		// Listening for signals and removing the listeners
		// when at least one symbol is aborted.
		signal.addEventListener('abort', () => controller.abort(signal.reason), { signal: controller.signal })
	}
	return controller.signal
}
