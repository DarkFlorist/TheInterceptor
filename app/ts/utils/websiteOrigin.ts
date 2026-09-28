function parseWebsiteUrl(urlString: string): URL | undefined {
	let url: URL
	try {
		url = new URL(urlString)
	} catch (error) {
		if (error instanceof TypeError) return undefined
		throw error
	}
	return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:' ? url : undefined
}

// The only persistent permission identity: scheme and effective port, or a per-file URL. Opaque origins cannot share a grant.
export function getWebsiteOrigin(urlString: string): string | undefined {
	const url = parseWebsiteUrl(urlString)
	if (url === undefined) return undefined
	if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
	// Local documents have opaque browser origins; scope their permissions to the individual file instead.
	if (url.protocol === 'file:') {
		url.hash = ''
		url.search = ''
		return url.href
	}
	return undefined
}

// Hostnames are a projection for metadata and DNR initiatorDomains, never a permission key. Imported legacy host-only settings still need this projection before startup migration.
export function getWebsiteHostname(urlString: string): string | undefined {
	const url = parseWebsiteUrl(urlString) ?? (urlString.includes('://') ? undefined : parseWebsiteUrl(`https://${ urlString }`))
	return url?.hostname || undefined
}

// Preserve the Firefox network-blocking policy's same-host exception across schemes. This comparison must not authorize provider access.
export function haveSameHostForNetworkBlocking(sourceUrl: string, destinationUrl: string): boolean {
	const source = parseWebsiteUrl(sourceUrl)
	const destination = parseWebsiteUrl(destinationUrl)
	return source !== undefined && destination !== undefined && source.host === destination.host
}

export function getWebsiteOriginForSender(sender: { readonly url?: string, readonly origin?: string }) {
	if (sender.url === undefined) return undefined
	if (sender.origin !== undefined && !sender.url.startsWith('file:')) return getWebsiteOrigin(sender.origin)
	return getWebsiteOrigin(sender.url)
}
