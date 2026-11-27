export type PageExtension = { readonly setContext: (context: unknown) => void }
export type PageExtensionRpc = (request: { readonly method: string, readonly params?: readonly unknown[] }) => Promise<unknown>
// Supplied only by the private bundled composition root, never by a page-global registry.
export type PageExtensionFactory = (requestRpc: PageExtensionRpc) => PageExtension
