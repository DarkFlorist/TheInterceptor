import { replaceProperty } from '../harness/globals.js'

export async function withSilencedConsole<T>(runWithConsoleSilenced: () => T | Promise<T>) {
	const restoreConsoleMethods = (['error', 'trace', 'warn'] as const).map((methodName) => replaceProperty(console, methodName, () => undefined))
	try {
		return await runWithConsoleSilenced()
	} finally {
		for (const restoreConsoleMethod of restoreConsoleMethods.reverse()) restoreConsoleMethod()
	}
}
