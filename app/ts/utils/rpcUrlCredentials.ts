// This module owns credentials embedded in RPC URLs: getRpcFetchTarget sends them, getRpcUrlCredentialsTransportError decides where they may go, redactRpcUrlCredentials masks them for display and logs, and removeRpcUrlCredentials drops them from exports.

// Browsers reject fetch URLs with embedded credentials, so configured `https://user:password@host` RPC URLs are sent as Basic auth instead, but only over https or loopback http.
export type RpcFetchTarget = {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
}

const REDACTED_URL_CREDENTIALS = '***'
const PERCENT_ESCAPE_OR_CHARACTER = /%[0-9a-f]{2}|[\s\S]/gi

function parseUrlOrUndefined(url: string) {
	try {
		return new URL(url)
	} catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

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

// The one credential transport check: the RPC form's save path calls it, and every RPC request, including the form's URL probe, reaches it through getRpcFetchTarget. Returns undefined for unparseable, credential-free, or safely sent URLs.
export function getRpcUrlCredentialsTransportError(rpcUrl: string) {
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl) || canSendRpcUrlCredentials(parsedUrl)) return undefined
	return `Credentials in RPC URL ${ redactRpcUrlCredentials(rpcUrl) } can only be sent over https, or over http to localhost.`
}

// Unparseable or credential-free URLs are returned unchanged so fetch keeps its existing behavior and errors. URLs that bypassed the RPC form, such as imported settings, throw rather than silently dropping their credentials.
export function getRpcFetchTarget(rpcUrl: string): RpcFetchTarget {
	const credentialsTransportError = getRpcUrlCredentialsTransportError(rpcUrl)
	if (credentialsTransportError !== undefined) throw new Error(credentialsTransportError)
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl)) return { url: rpcUrl, headers: {} }
	return { url: removeRpcUrlCredentials(rpcUrl), headers: { Authorization: getBasicAuthorizationHeaderValue(parsedUrl) } }
}

function replaceUrlCredentials(rpcUrl: string, replacementUsername: string) {
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl)) return rpcUrl
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
