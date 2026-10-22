import type { RpcEntries, RpcEntry, RpcNetwork } from '../types/rpc.js'

// This module owns credentials embedded in RPC URLs: getRpcFetchTarget sends them, getRpcUrlCredentialsTransportError decides where they may go, redactRpcUrlCredentials masks them for display and logs, removeRpcNetworkCredentialsForExport drops them from settings exports, and restoreRpcNetworkCredentialsForImport selects the stored entry that still has them when such an export is imported.

// Browsers reject fetch URLs with embedded credentials, so configured `https://user:password@host` RPC URLs are sent as Basic auth instead, but only over https or loopback http.
export type RpcFetchTarget = {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
}

const REDACTED_URL_CREDENTIALS = '***'
const PERCENT_ESCAPE_OR_CHARACTER = /%[0-9a-f]{2}|[\s\S]/gi
const SCHEME_AND_AUTHORITY_SLASHES = /^[a-z][a-z\d+.-]*:\/\//i

function parseUrlOrUndefined(url: string) {
	try {
		return new URL(url)
	} catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// The URL parser splits userinfo from the host only when it finds a host. A string it cannot parse, such as one with a malformed port or host, or one it parses without a host, such as `alice:secret@host` with its scheme missing, keeps any credentials elsewhere in the string.
function parseUrlWithHostOrUndefined(rpcUrl: string) {
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || parsedUrl.host === '') return undefined
	return parsedUrl
}

// Userinfo always ends with `@`, so a string without one has no credentials to find.
const mayContainUnparsedUserinfo = (rpcUrl: string) => rpcUrl.includes('@')

const hasUrlCredentials = (url: URL) => url.username !== '' || url.password !== ''

// The URL parser serializes every IPv4 host as four canonical decimal octets (`127.1` becomes `127.0.0.1`), so names such as `127.evil.com` never match.
function isIpv4LoopbackHostname(hostname: string) {
	const octets = hostname.split('.')
	if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false
	return Number(octets[0]) === 127
}

// Parsed hostnames are lowercase and IPv6 hosts keep their brackets, so `[::1]` is the only IPv6 loopback spelling.
const isLoopbackHostname = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || isIpv4LoopbackHostname(hostname)

// Basic auth over plaintext HTTP exposes reusable credentials to anyone on the network path, while loopback traffic never leaves the machine.
function canSendRpcUrlCredentials(url: URL) {
	if (url.protocol === 'https:') return true
	return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
}

// Parsed URL credentials are ASCII with UTF-8 bytes percent-encoded; malformed escapes stay literal, as in WHATWG percent-decode.
function percentDecodeToBytes(urlComponent: string) {
	return Array.from(urlComponent.matchAll(PERCENT_ESCAPE_OR_CHARACTER), ([token]) => token.length === 3 ? Number.parseInt(token.slice(1), 16) : token.charCodeAt(0))
}

const encodeBytesAsBase64 = (bytes: readonly number[]) => btoa(bytes.map((byte) => String.fromCharCode(byte)).join(''))

// Like browsers, an encoded `%3A` in the username decodes to a colon that servers read as the separator; RFC 7617 forbids colons in user-ids.
const getBasicAuthorizationHeaderValue = (url: URL) => `Basic ${ encodeBytesAsBase64(percentDecodeToBytes(`${ url.username }:${ url.password }`)) }`

// The one credential transport check: the RPC form's save path calls it, and every RPC request, including the form's URL probe, reaches it through getRpcFetchTarget. Strings containing `@` without a parsed host are refused because browsers echo the raw URL, credentials included, in fetch errors. Returns undefined for credential-free or safely sent URLs, and for strings without `@` that fetch can reject on its own.
export function getRpcUrlCredentialsTransportError(rpcUrl: string) {
	const parsedUrl = parseUrlWithHostOrUndefined(rpcUrl)
	if (parsedUrl === undefined) return mayContainUnparsedUserinfo(rpcUrl) ? `RPC URL ${ redactRpcUrlCredentials(rpcUrl) } could not be parsed as a URL with a host. Check its scheme, host, and port.` : undefined
	if (!hasUrlCredentials(parsedUrl) || canSendRpcUrlCredentials(parsedUrl)) return undefined
	return `Credentials in RPC URL ${ redactRpcUrlCredentials(rpcUrl) } can only be sent over https, or over http to localhost.`
}

// Credential-free URLs, and strings without `@` that cannot be parsed, are returned unchanged so fetch keeps its existing behavior and errors. URLs that bypassed the RPC form, such as imported settings, throw rather than silently dropping their credentials.
export function getRpcFetchTarget(rpcUrl: string): RpcFetchTarget {
	const credentialsTransportError = getRpcUrlCredentialsTransportError(rpcUrl)
	if (credentialsTransportError !== undefined) throw new Error(credentialsTransportError)
	const parsedUrl = parseUrlWithHostOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl)) return { url: rpcUrl, headers: {} }
	return { url: removeRpcUrlCredentials(rpcUrl), headers: { Authorization: getBasicAuthorizationHeaderValue(parsedUrl) } }
}

// Handles only strings parseUrlWithHostOrUndefined rejects: a malformed port or host, or a missing scheme. Without an `@` there is no userinfo and the string is returned unchanged. Otherwise it fails closed: everything after the scheme's `//`, or from the start without one, up to the last `@` counts as userinfo, because a password may itself contain `/` or `@`. An `@` in the path or query of such a string also drops what precedes it, which only mangles strings that are not usable RPC URLs.
function replaceUnparsedUserinfo(rpcUrl: string, replacementUserinfo: string) {
	const lastAtIndex = rpcUrl.lastIndexOf('@')
	if (lastAtIndex === -1) return rpcUrl
	const schemeAndAuthoritySlashes = SCHEME_AND_AUTHORITY_SLASHES.exec(rpcUrl)?.[0] ?? ''
	return `${ schemeAndAuthoritySlashes }${ replacementUserinfo }${ rpcUrl.slice(lastAtIndex + 1) }`
}

function replaceUrlCredentials(rpcUrl: string, replacementUsername: string) {
	const parsedUrl = parseUrlWithHostOrUndefined(rpcUrl)
	if (parsedUrl === undefined) return replaceUnparsedUserinfo(rpcUrl, replacementUsername === '' ? '' : `${ replacementUsername }@`)
	if (!hasUrlCredentials(parsedUrl)) return rpcUrl
	parsedUrl.username = replacementUsername
	parsedUrl.password = ''
	return parsedUrl.toString()
}

// The one way to display, log, or put an RPC URL in a diagnostic. Usernames can be API tokens, so the whole userinfo is masked.
export function redactRpcUrlCredentials(rpcUrl: string) {
	return replaceUrlCredentials(rpcUrl, REDACTED_URL_CREDENTIALS)
}

// Leaves a working credential-free URL, where the redaction placeholder would be read back as a bogus username.
export function removeRpcUrlCredentials(rpcUrl: string) {
	return replaceUrlCredentials(rpcUrl, '')
}

// Settings exports are shared for backups, syncing, and support requests, so the exported RPC network has its URL credentials removed rather than redacted: the file holds no working secret and still names a usable credential-free endpoint.
export function removeRpcNetworkCredentialsForExport(rpcNetwork: RpcNetwork): RpcNetwork {
	if (rpcNetwork.httpsRpc === undefined) return rpcNetwork
	return { ...rpcNetwork, httpsRpc: removeRpcUrlCredentials(rpcNetwork.httpsRpc) }
}

// The same endpoint apart from credentials: the same chain ID, and a URL that equals the imported one once its credentials are removed as an export removes them. Only these two fields are compared, written out here instead of using an RPC entry snapshot key, so new RpcNetwork fields cannot change which entry an import selects; name, currency, explorer, and list preferences may differ.
function isSameEndpointApartFromCredentials(storedEntry: RpcEntry, importedRpcEntry: RpcEntry) {
	return storedEntry.chainId === importedRpcEntry.chainId && removeRpcUrlCredentials(storedEntry.httpsRpc) === importedRpcEntry.httpsRpc
}

// Exports carry no credentials, so only the RPC list of the device importing the file can supply them; the caller passes that list, and import never writes it. The stored entry is selected only when it is the single match and has credentials: several matches would make the credentials a guess, and a lone credential-free match is the imported endpoint itself. Credential-free entries count as matches, so a credential-free selection stored next to its credentialed counterpart stays credential-free. An imported URL that still has credentials, from a file exported before credentials were removed, equals no credential-free URL and is kept as imported.
export function restoreRpcNetworkCredentialsForImport(importedRpcNetwork: RpcNetwork, storedRpcEntries: RpcEntries): RpcNetwork {
	if (importedRpcNetwork.httpsRpc === undefined) return importedRpcNetwork
	const [onlyMatch, ...otherMatches] = storedRpcEntries.filter((storedEntry) => isSameEndpointApartFromCredentials(storedEntry, importedRpcNetwork))
	if (onlyMatch === undefined || otherMatches.length > 0 || removeRpcUrlCredentials(onlyMatch.httpsRpc) === onlyMatch.httpsRpc) return importedRpcNetwork
	return onlyMatch
}
