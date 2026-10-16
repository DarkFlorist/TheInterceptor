// Browsers reject fetch URLs with embedded credentials, so configured `https://user:password@host` RPC URLs are sent as Basic auth instead.
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

// Parsed URL credentials are ASCII with UTF-8 bytes percent-encoded; malformed escapes stay literal, as in WHATWG percent-decode.
function percentDecodeToBytes(urlComponent: string) {
	return Array.from(urlComponent.matchAll(PERCENT_ESCAPE_OR_CHARACTER), ([token]) => token.length === 3 ? Number.parseInt(token.slice(1), 16) : token.charCodeAt(0))
}

const encodeBytesAsBase64 = (bytes: readonly number[]) => btoa(bytes.map((byte) => String.fromCharCode(byte)).join(''))

// Like browsers, an encoded `%3A` in the username decodes to a colon that servers read as the separator; RFC 7617 forbids colons in user-ids.
const getBasicAuthorizationHeaderValue = (url: URL) => `Basic ${ encodeBytesAsBase64(percentDecodeToBytes(`${ url.username }:${ url.password }`)) }`

// Unparseable or credential-free URLs are returned unchanged so fetch keeps its existing behavior and errors.
export function getRpcFetchTarget(rpcUrl: string): RpcFetchTarget {
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl)) return { url: rpcUrl, headers: {} }
	const authorization = getBasicAuthorizationHeaderValue(parsedUrl)
	parsedUrl.username = ''
	parsedUrl.password = ''
	return { url: parsedUrl.toString(), headers: { Authorization: authorization } }
}

// Use for every displayed, logged, or diagnostic RPC URL. Usernames can be API tokens, so the whole userinfo is masked.
export function redactRpcUrlCredentials(rpcUrl: string) {
	const parsedUrl = parseUrlOrUndefined(rpcUrl)
	if (parsedUrl === undefined || !hasUrlCredentials(parsedUrl)) return rpcUrl
	parsedUrl.username = REDACTED_URL_CREDENTIALS
	parsedUrl.password = ''
	return parsedUrl.toString()
}
