export type PageExtension = { readonly setContext: (context: unknown) => void, readonly dispose: () => void }
export type PageExtensionRpc = (request: { readonly method: string, readonly params?: readonly unknown[] }) => Promise<unknown>
export type PageExtensionFactory = (requestRpc: PageExtensionRpc) => PageExtension

// Factories are supplied only by the bundled composition root, never by a page-global registration API. The internal RPC closure stays inside this module graph.
export function createPageExtensions(requestRpc: PageExtensionRpc, factories: readonly PageExtensionFactory[]): PageExtension {
	const extensions = factories.map((factory) => factory(requestRpc))
	let disposed = false
	return {
		setContext(value) { if (!disposed) for (const extension of extensions) extension.setContext(value) },
		dispose() {
			if (disposed) return
			disposed = true
			for (const extension of extensions) extension.dispose()
		},
	}
}
