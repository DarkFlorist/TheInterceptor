// Permission keys include the scheme and effective port. Opaque origins cannot share a persistent grant.
export function getWebsiteOrigin(urlString: string): string | undefined {
	let url: URL
	try {
		url = new URL(urlString)
	} catch (error) {
		if (error instanceof TypeError) return undefined
		throw error
	}
	if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
	// Local documents have opaque browser origins; scope their permissions to the individual file instead.
	if (url.protocol === 'file:') {
		url.hash = ''
		url.search = ''
		return url.href
	}
	return undefined
}

export function getWebsiteOriginForSender(sender: { readonly url?: string, readonly origin?: string }) {
	if (sender.url === undefined) return undefined
	if (sender.origin !== undefined && !sender.url.startsWith('file:')) return getWebsiteOrigin(sender.origin)
	return getWebsiteOrigin(sender.url)
}
