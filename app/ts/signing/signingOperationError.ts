const expectedSigningErrors = new WeakSet<Error>()

/** A failed signing precondition that the user can resolve by reviewing or updating the request. */
export function signingOperationError(message: string) {
	const error = new Error(message)
	expectedSigningErrors.add(error)
	return error
}

export function isSigningOperationError(error: unknown): error is Error {
	return error instanceof Error && expectedSigningErrors.has(error)
}
