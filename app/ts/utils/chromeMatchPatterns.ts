// Disabled sites include subdomains and unspecified ports; hosting selects exactly one scheme, host and effective port.
export function getChromeMatchPatterns(value: string, intent: 'exact-origin' | 'site-with-subdomains') {
	if (value === '') return intent === 'site-with-subdomains' ? ['file:///*'] : []
	const hasExplicitScheme = value.includes('://')
	if (intent === 'exact-origin' && !hasExplicitScheme) return []
	let url: URL
	try { url = new URL(hasExplicitScheme ? value : `http://${ value }`) } catch { return [] }
	if (url.protocol === 'file:') return intent === 'site-with-subdomains' && url.hostname === '' ? ['file:///*'] : []
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
	if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.hostname === '' || url.hostname.includes('*')) return []
	const isIpAddressOrLocalhost = url.hostname === 'localhost' || url.hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(url.hostname)
	const hostname = intent === 'site-with-subdomains' && !isIpAddressOrLocalhost ? `*.${ url.hostname }` : url.hostname
	// Chrome treats an omitted port as a wildcard, so an exact origin must specify even its default port.
	const port = intent === 'exact-origin' ? url.port || (url.protocol === 'https:' ? '443' : '80') : url.port
	const host = port === '' ? hostname : `${ hostname }:${ port }`
	const schemes = hasExplicitScheme ? [url.protocol] : url.port === '' ? ['*:'] : ['http:', 'https:']
	return schemes.map((scheme) => `${ scheme }//${ host }/*`)
}
