import { SiweMessage } from '../types/personal-message-definitions.js'
import { isAddress } from './ethereumBytes.js'
import { getSchemeAndHostWithPort } from './requests.js'

// EIP-4361 Sign-In with Ethereum. The parser follows the EIP's ABNF line by line and returns undefined for anything that does not conform exactly, so near-misses keep being shown as plain messages.

const HEADER_PATTERN = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Ethereum account:$/u
// RFC 3986 authority: optional userinfo, an IP literal or registered name, and an optional port. IPvFuture literals are not accepted, and neither is the percent-encoding RFC 3986 allows: URL normalization would decode `%65vil.example` to `evil.example`, so the domain shown to the user would differ from the host that is compared with the requesting website.
const AUTHORITY_PATTERN = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:]*@)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9\-._~!$&'()*+,;=]+)(?::[0-9]*)?$/u
// RFC 3986 reserved and unreserved characters plus space, which excludes line breaks.
const STATEMENT_PATTERN = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]*$/u
// RFC 3986 `pchar`: the characters of a path segment, also used by queries and fragments.
const URI_PCHAR = /(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})/u
// RFC 3986 `authority = [ userinfo "@" ] host [ ":" port ]`. The characters of an IP literal are checked here and its exact IPv6 syntax by the URL parser in isSiweUri.
const URI_AUTHORITY = /(?:(?:[A-Za-z0-9\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::[0-9]*)?/u
// RFC 3986 `URI = scheme ":" hier-part [ "?" query ] [ "#" fragment ]`, where `hier-part` is "//" with an authority and an absolute path, or a path that does not start with "//". It covers opaque URIs such as `did:` and `urn:` as well as `https://` and `ipfs://` ones.
const URI_PATTERN = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:(?://${ URI_AUTHORITY.source }(?:/${ URI_PCHAR.source }*)*|/?(?:${ URI_PCHAR.source }+(?:/${ URI_PCHAR.source }*)*)?)(?:[?](?:${ URI_PCHAR.source }|[/?])*)?(?:#(?:${ URI_PCHAR.source }|[/?])*)?$`, 'u')
const CHAIN_ID_PATTERN = /^[0-9]+$/u
const NONCE_PATTERN = /^[A-Za-z0-9]{8,}$/u
// RFC 3986 pchar.
const REQUEST_ID_PATTERN = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*$/u
// RFC 3339 date-time. ABNF string literals are case-insensitive, so the "T" and "Z" separators may be lower case.
const DATE_TIME_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))$/u

// EIP-4361 asks wallets to warn when this phrase appears in a message that is not a conforming sign-in message. Matching is loose about case and whitespace so small edits cannot slip past it.
const SIWE_PHRASE_PATTERN = /wants\s+you\s+to\s+sign\s+in\s+with\s+your\s+ethereum\s+account/iu

// EIP-4361: "If `scheme` is not specified, HTTPS is assumed by default."
const SIWE_DEFAULT_SCHEME = 'https'

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

function getDaysInMonth(year: number, month: number) {
	if (month === 2) return isLeapYear(year) ? 29 : 28
	return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function parseSiweDateTime(text: string): Date | undefined {
	const match = DATE_TIME_PATTERN.exec(text)
	if (match === null) return undefined
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
	const fraction = match[7] ?? ''
	const offsetSign = match[9] === '-' ? -1 : 1
	const offsetHours = Number(match[10] ?? '0')
	const offsetMinutes = Number(match[11] ?? '0')
	if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return undefined
	if (month < 1 || month > 12 || day < 1 || day > getDaysInMonth(year, month)) return undefined
	// A second of 60 is an RFC 3339 leap second.
	if (hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59) return undefined
	const date = new Date(0)
	// setUTCFullYear keeps years below 100 as written, unlike Date.UTC.
	date.setUTCFullYear(year, month - 1, day)
	date.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)))
	return new Date(date.getTime() - offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000)
}

// Undefined means the text is not a URL, so the domain never matches the requesting website and a URI field does not conform.
function parseUrl(text: string) {
	try {
		return new URL(text)
	} catch (error: unknown) {
		// `new URL` reports unparseable input with a TypeError; anything else is unexpected and propagates.
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// The `URI:` field and each resource must be RFC 3986 URIs. The grammar check is completed by the URL parser, which rejects malformed IP literals such as `[abc]`; it is slightly stricter than RFC 3986, for example about ports above 65535, and such a message only falls back to the look-alike warning.
const isSiweUri = (text: string) => URI_PATTERN.test(text) && parseUrl(text) !== undefined

export function parseSiweMessage(message: string): SiweMessage | undefined {
	const lines = message.split('\n')
	const header = HEADER_PATTERN.exec(lines[0] ?? '')
	const domain = header?.[2]
	if (header === null || domain === undefined || !AUTHORITY_PATTERN.test(domain)) return undefined
	const addressText = lines[1]
	// EIP-4361 asks for an EIP-55 checksummed address. `isAddress` checks the `0x` and 40 hex digit form, accepts all-lowercase and all-uppercase addresses because they carry no checksum, and rejects a mixed-case address with a wrong checksum.
	if (addressText === undefined || !isAddress(addressText)) return undefined
	if (lines[2] !== '') return undefined

	// `LF [ statement LF ] LF`: without a statement the address is followed by two blank lines, and an empty statement adds a third.
	const statementLine = lines[3]
	if (statementLine === undefined) return undefined
	const hasStatementLine = statementLine !== '' || lines[4] === ''
	if (hasStatementLine && lines[4] !== '') return undefined
	let lineIndex = hasStatementLine ? 5 : 4
	const readField = (tag: string) => {
		const line = lines[lineIndex]
		if (line === undefined || !line.startsWith(tag)) return undefined
		lineIndex++
		return line.slice(tag.length)
	}

	const uri = readField('URI: ')
	const version = readField('Version: ')
	const chainIdText = readField('Chain ID: ')
	const nonce = readField('Nonce: ')
	const issuedAt = readField('Issued At: ')
	const expirationTime = readField('Expiration Time: ')
	const notBefore = readField('Not Before: ')
	const requestId = readField('Request ID: ')
	const resources: string[] = []
	if (lines[lineIndex] === 'Resources:') {
		lineIndex++
		for (let resource = readField('- '); resource !== undefined; resource = readField('- ')) resources.push(resource)
	}
	// Fields are only read in the order the ABNF lists them, so a field out of order, an unknown line or a trailing line break is left over here.
	if (lineIndex !== lines.length) return undefined

	if (uri === undefined || !isSiweUri(uri)) return undefined
	if (version !== '1') return undefined
	if (chainIdText === undefined || !CHAIN_ID_PATTERN.test(chainIdText)) return undefined
	if (nonce === undefined || !NONCE_PATTERN.test(nonce)) return undefined
	if (issuedAt === undefined || parseSiweDateTime(issuedAt) === undefined) return undefined
	if (expirationTime !== undefined && parseSiweDateTime(expirationTime) === undefined) return undefined
	if (notBefore !== undefined && parseSiweDateTime(notBefore) === undefined) return undefined
	if (requestId !== undefined && !REQUEST_ID_PATTERN.test(requestId)) return undefined
	if (!STATEMENT_PATTERN.test(statementLine)) return undefined
	if (!resources.every(isSiweUri)) return undefined

	const parsedMessage: SiweMessage = {
		scheme: header[1],
		domain,
		address: BigInt(addressText),
		statement: statementLine === '' ? undefined : statementLine,
		uri,
		version,
		chainId: BigInt(chainIdText),
		nonce,
		issuedAt,
		expirationTime,
		notBefore,
		requestId,
		resources,
	}
	// The parsed message is stored with the pending request, so it must fit its storage schema. The patterns above already keep the text fields and the address within it, but a chain ID of 2^256 or more does not fit an EthereumQuantity; such a message is left unparsed like any other message that does not conform.
	return SiweMessage.safeSerialize(parsedMessage).success ? parsedMessage : undefined
}

export const looksLikeSiweMessage = (message: string) => SIWE_PHRASE_PATTERN.test(message)

export const SIWE_LOOKALIKE_QUARANTINE_REASON = 'This message looks like a Sign-In with Ethereum request but does not follow the EIP-4361 format, so the Interceptor cannot check which website it signs you in to.'

// For a message that parseSiweMessage leaves unparsed: one that still reads like a sign-in request cannot get the website check of getSiweQuarantineReasons, so it is flagged instead of passing as an ordinary message.
export const getSiweLookalikeQuarantineReasons = (message: string): readonly string[] => looksLikeSiweMessage(message) ? [SIWE_LOOKALIKE_QUARANTINE_REASON] : []

// Advisory warnings for a sign-in message outside its validity window: EIP-4361 leaves enforcing the window to the relying party that verifies the signature, so these warn the user but neither quarantine the request nor block signing. The result depends on the current time, so it is not stored with the request (and so adds no confirmation checkbox or Flagged badge): the confirmation dialog re-evaluates it while it is shown.
export function getSiweValidityWarnings(message: SiweMessage, now: Date): readonly string[] {
	const warnings: string[] = []
	const expirationTime = message.expirationTime === undefined ? undefined : parseSiweDateTime(message.expirationTime)
	if (expirationTime !== undefined && expirationTime.getTime() <= now.getTime()) warnings.push(`This sign-in message expired at ${ expirationTime.toISOString() }.`)
	const notBefore = message.notBefore === undefined ? undefined : parseSiweDateTime(message.notBefore)
	if (notBefore !== undefined && notBefore.getTime() > now.getTime()) warnings.push(`This sign-in message is not valid until ${ notBefore.toISOString() }, so signing it now gives the website a sign-in it can use later.`)
	return warnings
}

// The scheme and domain exactly as the message states them, which is what the user is asked to sign in to.
export const getSiweOriginText = (message: SiweMessage) => message.scheme === undefined ? message.domain : `${ message.scheme }://${ message.domain }`

export const getSiweScheme = (message: SiweMessage) => (message.scheme ?? SIWE_DEFAULT_SCHEME).toLowerCase()

// The origin the message signs in to, normalized with getSchemeAndHostWithPort exactly like the recorded origin of a requesting frame (getFrameOrigins): for http and https the host is lowercased and a default port is dropped. Returns undefined when the domain carries userinfo (`user@host`), which websites never have and which can be used to disguise the real host, or when it is not a valid URL authority. Userinfo is detected from the raw text because URL parsing reports an empty userinfo (`@host`, `:@host`) as no userinfo at all.
export function getSiweMessageOrigin(message: SiweMessage) {
	if (message.domain.includes('@')) return undefined
	const url = parseUrl(`${ getSiweScheme(message) }://${ message.domain }`)
	if (url === undefined) return undefined
	return getSchemeAndHostWithPort(url.href)
}

// The EIP-4361 wallet check that is specific to sign-in messages: the message must be for the website that sent the request. `requestOrigin` is the full origin of the requesting frame (`SignedMessageTransaction.requestOrigin`), and the two are compared exactly, so an http page cannot ask for an https sign-in and a subdomain or a parent domain does not match either. The account and chain checks are shared with other signatures through getSigningQuarantineCodes, and the validity window is checked by the dialog with getSiweValidityWarnings because it changes while a request is pending.
export function getSiweQuarantineReasons(siweMessage: SiweMessage, requestOrigin: string | undefined): readonly string[] {
	const messageOriginText = `${ getSiweScheme(siweMessage) }://${ siweMessage.domain }`
	// A request without a recorded origin (stored before origins were recorded, imported from a simulation stack export, or whose frame had already disconnected) is flagged rather than compared by host alone or trusted from an export file, so it can never pass as the website it names.
	if (requestOrigin === undefined) return [`This sign-in message is for ${ messageOriginText }, but the Interceptor did not record the full origin of the website that requested it, so it cannot check that they match.`]
	if (getSiweMessageOrigin(siweMessage) === requestOrigin) return []
	const impliedSchemeNote = siweMessage.scheme === undefined && !requestOrigin.startsWith(`${ SIWE_DEFAULT_SCHEME }://`) ? ` (a sign-in message that names no scheme is for ${ SIWE_DEFAULT_SCHEME })` : ''
	return [`This sign-in message is for ${ messageOriginText }${ impliedSchemeNote }, but it was requested by ${ requestOrigin }. A website asking you to sign in to a different website is a common phishing attack.`]
}
