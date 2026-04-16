export type RouteHandler<Context, Payload, Result = unknown> = (context: Context, payload: Payload) => Promise<Result> | Result

export function createRouter<Context>() {
	const handlers = new Map<string, RouteHandler<Context, unknown>>()
	return {
		register<Payload, Result = unknown>(action: string, handler: RouteHandler<Context, Payload, Result>) {
			handlers.set(action, handler as RouteHandler<Context, unknown>)
			return this
		},
		async dispatch(action: string, context: Context, payload: unknown) {
			const handler = handlers.get(action)
			if (handler === undefined) throw new Error(`No handler registered for action "${ action }"`)
			return await handler(context, payload)
		}
	}
}
