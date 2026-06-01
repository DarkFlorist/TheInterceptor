export function tryOrUndefined<T>(fn: () => T, isExpected: (error: unknown) => boolean) {
	try {
		return fn()
	} catch (error) {
		if (isExpected(error)) return undefined
		throw error
	}
}

export function tryOrFalse(fn: () => unknown, isExpected: (error: unknown) => boolean) {
	try {
		fn()
		return true
	} catch (error) {
		if (isExpected(error)) return false
		throw error
	}
}
