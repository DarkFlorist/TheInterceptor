// Track external work separately from selection itself so a lease recheck never depends on call nesting.
export function createSignerSelectionGate(onIdle: () => void) {
	const blockers = new Set<symbol>()
	const selections = new Set<symbol>()
	const isIdle = () => blockers.size === 0 && selections.size === 0
	const notifyIdle = () => { if (isIdle()) onIdle() }
	const block = () => {
		const token = Symbol()
		blockers.add(token)
		return () => { blockers.delete(token); notifyIdle() }
	}
	const runBlocked = async <T>(work: () => Promise<T>) => {
		const release = block()
		try { return await work() } finally { release() }
	}
	const runSelection = async <T>(work: () => Promise<T>) => {
		const token = Symbol()
		selections.add(token)
		try { return await work() } finally { selections.delete(token); notifyIdle() }
	}
	return { block, runBlocked, runSelection, isIdle, hasExternalBlockers: () => blockers.size > 0 }
}
