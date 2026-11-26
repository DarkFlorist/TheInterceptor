export async function withBrowserCommandTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 30_000) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`${ label } timed out after ${ timeoutMs } milliseconds`)), timeoutMs) })])
	} finally { if (timeout !== undefined) clearTimeout(timeout) }
}
