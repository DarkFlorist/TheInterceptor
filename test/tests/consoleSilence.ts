export async function withSilencedConsole<T>(runWithConsoleSilenced: () => T | Promise<T>) {
	const originalConsole = {
		error: console.error,
		trace: console.trace,
		warn: console.warn,
	}
	console.error = () => undefined
	console.trace = () => undefined
	console.warn = () => undefined
	try {
		return await runWithConsoleSilenced()
	} finally {
		console.error = originalConsole.error
		console.trace = originalConsole.trace
		console.warn = originalConsole.warn
	}
}
