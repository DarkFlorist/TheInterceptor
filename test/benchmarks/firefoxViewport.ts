type FirefoxViewportConnection = { send: (method: string, params: Record<string, unknown>) => Promise<unknown> }

function property(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function positiveInteger(value: unknown, description: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Firefox ${ description }: ${ String(value) }`)
	return value
}

// Firefox rejects context-targeted viewport emulation for extension principals. Its user-context path applies the same emulator, whose resize synchronization explicitly supports privileged contexts in Mozilla's _updateNavigableViewport. The scope includes current and future tabs in that user context; native-window sizing cannot represent narrow viewports.
export async function setFirefoxViewport(connection: FirefoxViewportConnection, context: string, width: number, height: number, readViewport: () => Promise<unknown>) {
	positiveInteger(width, 'requested viewport width')
	positiveInteger(height, 'requested viewport height')
	const tree = await connection.send('browsingContext.getTree', { root: context, maxDepth: 0 })
	const contexts = property(tree, 'contexts')
	const target = Array.isArray(contexts) ? contexts.find((candidate: unknown) => property(candidate, 'context') === context) : undefined
	const userContext = property(target, 'userContext')
	if (typeof userContext !== 'string' || userContext.length === 0) throw new Error('Firefox did not return the target browsing context’s user context')
	await connection.send('browsingContext.setViewport', { userContexts: [userContext], viewport: { width, height }, devicePixelRatio: 1 })
	const measured = await readViewport()
	const actualWidth = positiveInteger(property(measured, 'innerWidth'), 'viewport width')
	const actualHeight = positiveInteger(property(measured, 'innerHeight'), 'viewport height')
	if (actualWidth !== width || actualHeight !== height) throw new Error(`Firefox could not set viewport ${ width }x${ height }; received ${ actualWidth }x${ actualHeight }`)
}
