export type PageExtension = { readonly setContext: (context: unknown) => void, readonly dispose: () => void }
export type PageExtensionRpc = (chainId: string, request: unknown) => Promise<unknown>
type PageExtensionFactory = (requestRpc: PageExtensionRpc) => PageExtension

// An explicit page-world extension point shared by independently bundled classic scripts. The core only owns context delivery and a read-only RPC transport; feature code owns its hooks and adapters.
const registrationKey = Symbol.for('TheInterceptor.pageExtensions')

export function createPageExtensions(host: object, requestRpc: PageExtensionRpc): PageExtension {
	let context: unknown
	let contextPublished = false
	let disposed = false
	const extensions = new Map<string, PageExtension>()
	const registration = {
		register(id: string, factory: PageExtensionFactory) {
			if (disposed || extensions.has(id)) return
			const extension = factory(requestRpc)
			extensions.set(id, extension)
			if (contextPublished) extension.setContext(context)
		},
	}
	Reflect.set(host, registrationKey, registration)
	return {
		setContext(value) { contextPublished = true; context = value; for (const extension of extensions.values()) extension.setContext(value) },
		dispose() {
			disposed = true
			for (const extension of extensions.values()) extension.dispose()
			extensions.clear()
			if (Reflect.get(host, registrationKey) === registration) Reflect.deleteProperty(host, registrationKey)
		},
	}
}

export function registerPageExtension(host: object, id: string, factory: PageExtensionFactory) {
	const registration: unknown = Reflect.get(host, registrationKey)
	if (typeof registration !== 'object' || registration === null || !('register' in registration) || typeof registration.register !== 'function') throw new Error('Interceptor provider must initialize before its page extensions.')
	registration.register(id, factory)
}
