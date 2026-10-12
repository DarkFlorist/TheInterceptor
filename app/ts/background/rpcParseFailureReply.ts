import type * as funtypes from 'funtypes'
import type { RPCReply } from '../types/interceptor-messages.js'
import { EthGetLogsRequest, PartialEthereumTransaction, type SupportedEthereumJsonRpcRequestCodec } from '../types/JsonRpc-types.js'
import { EthSimulateV1BlockTag } from '../types/ethSimulate-types.js'
import { EIP712Message, EIP712MessageUnderlying } from '../types/eip721.js'
import { CanonicalEthereumQuantity, EthereumAddress, EthereumBlockTag, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity } from '../types/wire-types.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { jsonParserWithNumbersAsStringsConverter } from '../utils/json.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { assertNever } from '../utils/typescript.js'
import { getWatchAssetRpcParseFailureReply } from './watchAssetRpc.js'
import { getWalletGetCapabilitiesParseFailureReply } from './walletGetCapabilitiesRpc.js'

// Method-specific parse failure replies take precedence over the generic invalid-params message.
const METHOD_SPECIFIC_PARSE_FAILURE_REPLIES = [getWatchAssetRpcParseFailureReply, getWalletGetCapabilitiesParseFailureReply]

export function getMethodSpecificParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	for (const getMethodSpecificReply of METHOD_SPECIFIC_PARSE_FAILURE_REPLIES) {
		const methodSpecificReply = getMethodSpecificReply(request)
		if (methodSpecificReply !== undefined) return methodSpecificReply
	}
	return undefined
}

// The part of a funtypes codec that every codec exposes. Tag-specific reflection members such as `fields` or `alternatives` are read through the runtime-validated accessors below.
type ReflectedCodec = {
	readonly tag: string
	safeParse(value: unknown): funtypes.Result<unknown>
}

// A funtypes failure of one codec for one value. The key is the path from that value to the failing value, for example `params.[0].to`.
type ValueFailure = {
	readonly message: string
	readonly key?: string
}

type JsonDocumentDescription = {
	readonly name: string
	readonly shape: string
	readonly codec: ReflectedCodec
}

type KnownCodecDescription = {
	readonly label: string
	// Codecs with an expectation are reported as a whole instead of being inspected structurally.
	readonly expected?: string
	// Strings that encode a JSON document are decoded and inspected with the document codec.
	readonly jsonDocument?: JsonDocumentDescription
}

const BLOCK_TAG_EXPECTATION = 'a block number, block hash or block tag ("latest", "pending", "safe", "finalized" or "earliest")'
const EIP712_TYPED_DATA_DOCUMENT = { name: 'EIP-712 typed data', shape: 'a JSON object with types, primaryType, domain and message', codec: EIP712MessageUnderlying }
const KNOWN_CODEC_DESCRIPTIONS = new Map<ReflectedCodec, KnownCodecDescription>([
	[EthereumAddress, { label: 'address', expected: 'a 20-byte hex address' }],
	[EthereumQuantity, { label: 'quantity', expected: 'a hex quantity' }],
	[CanonicalEthereumQuantity, { label: 'quantity', expected: 'a hex quantity without leading zeros' }],
	[EthereumBlockTag, { label: 'block tag', expected: BLOCK_TAG_EXPECTATION }],
	[EthSimulateV1BlockTag, { label: 'block tag', expected: BLOCK_TAG_EXPECTATION }],
	[EthereumBytes32, { label: 'hash', expected: 'a 32-byte hex value' }],
	[EthereumData, { label: 'data', expected: 'hex-encoded bytes' }],
	[EthereumInput, { label: 'data', expected: 'hex-encoded bytes' }],
	[EIP712Message, { label: 'typed data', expected: 'EIP-712 typed data encoded as a JSON string', jsonDocument: EIP712_TYPED_DATA_DOCUMENT }],
	[PartialEthereumTransaction, { label: 'transaction object' }],
	[EthGetLogsRequest, { label: 'log filter' }],
])

// Codec tags that validate a value with their `underlying` codec before applying their own check. Lazy codecs store a function that returns the underlying codec.
const WRAPPER_CODEC_TAGS = new Set(['constraint', 'parsed', 'sealed', 'named', 'lazy'])
const MAX_ECHOED_STRING_LENGTH = 80
const MAX_REASON_LENGTH = 200

const isReflectedCodec = (value: unknown): value is ReflectedCodec => typeof value === 'object'
	&& value !== null
	&& 'tag' in value
	&& typeof value.tag === 'string'
	&& 'safeParse' in value
	&& typeof value.safeParse === 'function'

const getChildCodec = (codec: ReflectedCodec, member: 'element' | 'value') => {
	const child: unknown = Reflect.get(codec, member)
	return isReflectedCodec(child) ? child : undefined
}

const getChildCodecs = (codec: ReflectedCodec, member: 'alternatives' | 'components' | 'intersectees'): readonly ReflectedCodec[] => {
	const children: unknown = Reflect.get(codec, member)
	return Array.isArray(children) ? children.filter(isReflectedCodec) : []
}

const getOwnProperty = (value: object, property: string): unknown => Object.prototype.hasOwnProperty.call(value, property) ? Reflect.get(value, property) : undefined

const getFieldCodec = (objectCodec: ReflectedCodec, fieldName: string) => {
	const fields: unknown = Reflect.get(objectCodec, 'fields')
	if (typeof fields !== 'object' || fields === null) return undefined
	const fieldCodec = getOwnProperty(fields, fieldName)
	return isReflectedCodec(fieldCodec) ? fieldCodec : undefined
}

const getUnderlyingCodec = (codec: ReflectedCodec) => {
	if (!WRAPPER_CODEC_TAGS.has(codec.tag)) return undefined
	const underlying: unknown = Reflect.get(codec, 'underlying')
	const resolvedUnderlying: unknown = typeof underlying === 'function' ? underlying() : underlying
	return isReflectedCodec(resolvedUnderlying) ? resolvedUnderlying : undefined
}

const unwrapCodec = (codec: ReflectedCodec): ReflectedCodec => {
	const underlying = getUnderlyingCodec(codec)
	return underlying === undefined ? codec : unwrapCodec(underlying)
}

const getValueKind = (value: unknown) => {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	return typeof value
}

// The kind of JavaScript value a codec accepts, or undefined when it accepts several kinds.
function getAcceptedValueKind(codec: ReflectedCodec): string | undefined {
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return getAcceptedValueKind(underlying)
	switch (codec.tag) {
		case 'string':
		case 'number':
		case 'boolean': return codec.tag
		case 'literal': return getValueKind(Reflect.get(codec, 'value'))
		case 'object':
		case 'record': return 'object'
		case 'array':
		case 'tuple': return 'array'
		case 'intersect': {
			const [firstIntersectee] = getChildCodecs(codec, 'intersectees')
			return firstIntersectee === undefined ? undefined : getAcceptedValueKind(firstIntersectee)
		}
		case 'union': {
			const alternativeKinds = new Set(getChildCodecs(codec, 'alternatives').map(getAcceptedValueKind))
			const [onlyKind] = alternativeKinds
			return alternativeKinds.size === 1 ? onlyKind : undefined
		}
		default: return undefined
	}
}

// Whether a value has the kind a codec accepts and, for tuples, the expected number of items.
const acceptsValueShape = (codec: ReflectedCodec, value: unknown) => {
	const acceptedKind = getAcceptedValueKind(codec)
	if (acceptedKind !== undefined && acceptedKind !== getValueKind(value)) return false
	const unwrappedCodec = unwrapCodec(codec)
	return unwrappedCodec.tag !== 'tuple' || !Array.isArray(value) || getChildCodecs(unwrappedCodec, 'components').length === value.length
}

const formatAlternatives = (alternatives: readonly string[]) => {
	if (alternatives.length <= 1) return alternatives.join('')
	return `${ alternatives.slice(0, -1).join(', ') } or ${ alternatives[alternatives.length - 1] }`
}

const formatLiteral = (value: unknown) => value === undefined ? 'undefined' : JSON.stringify(value)

function describeExpectedValue(codec: ReflectedCodec): string {
	const knownExpectation = KNOWN_CODEC_DESCRIPTIONS.get(codec)?.expected
	if (knownExpectation !== undefined) return knownExpectation
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return describeExpectedValue(underlying)
	switch (codec.tag) {
		case 'string': return 'a string'
		case 'number': return 'a number'
		case 'boolean': return 'a boolean'
		case 'literal': return formatLiteral(Reflect.get(codec, 'value'))
		case 'never': return 'no value'
		case 'object':
		case 'record':
		case 'intersect': return 'an object'
		case 'array': return 'an array'
		case 'tuple': return `an array of ${ getChildCodecs(codec, 'components').length } items`
		case 'union': return formatAlternatives([...new Set(getChildCodecs(codec, 'alternatives').map(describeExpectedValue))])
		default: return 'a valid value'
	}
}

function getParameterLabel(codec: ReflectedCodec): string | undefined {
	const knownLabel = KNOWN_CODEC_DESCRIPTIONS.get(codec)?.label
	if (knownLabel !== undefined) return knownLabel
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return getParameterLabel(underlying)
	switch (codec.tag) {
		case 'string':
		case 'number':
		case 'boolean': return codec.tag
		default: return undefined
	}
}

function describeReceivedValue(value: unknown) {
	if (typeof value === 'string') return value.length <= MAX_ECHOED_STRING_LENGTH ? JSON.stringify(value) : `a ${ value.length }-character string`
	if (Array.isArray(value)) return `an array of ${ value.length } item${ value.length === 1 ? '' : 's' }`
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'object') return 'an object'
	return typeof value
}

const toSentenceFragment = (text: string) => {
	const withoutTrailingPeriod = text.trim().replace(/\.$/, '')
	return withoutTrailingPeriod.length <= MAX_REASON_LENGTH ? withoutTrailingPeriod : `${ withoutTrailingPeriod.slice(0, MAX_REASON_LENGTH) }...`
}

function decodeJsonDocument(text: string): { readonly success: true, readonly value: unknown } | { readonly success: false } {
	try {
		return { success: true, value: jsonParserWithNumbersAsStringsConverter(text) }
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return { success: false }
		throw error
	}
}

type ValuePath = readonly (string | number)[]

type ValueNode = {
	readonly codec: ReflectedCodec
	readonly value: unknown
	readonly path: ValuePath
}

// Message text is derived from these problems only for the one problem that is reported.
type ValueProblem =
	| { readonly kind: 'missing', readonly path: ValuePath }
	| { readonly kind: 'wrongFormat', readonly path: ValuePath, readonly codec: ReflectedCodec, readonly received: unknown }
	| { readonly kind: 'rejected', readonly path: ValuePath, readonly reason: string }
	// documentProblem is undefined when the string is not JSON at all.
	| { readonly kind: 'invalidJsonDocument', readonly path: ValuePath, readonly document: JsonDocumentDescription, readonly documentProblem: ValueProblem | undefined }

// Splits the first segment off a funtypes failure key. Discriminated-union segments such as `<type: "ERC20">` are not followed.
function splitFailureKey(key: string | undefined) {
	if (key === undefined || key === '' || key.startsWith('<')) return undefined
	const separatorIndex = key.indexOf('.')
	const segment = separatorIndex === -1 ? key : key.slice(0, separatorIndex)
	const indexMatch = /^\[(\d+)\]$/.exec(segment)
	return {
		segment: indexMatch?.[1] === undefined ? segment : Number(indexMatch[1]),
		remainingKey: separatorIndex === -1 ? undefined : key.slice(separatorIndex + 1),
	}
}

// Picks the intersectee that produced a failure at this segment. Several intersectees can accept the segment, for example an open record next to an object with declared fields; the first one that rejects its child value is the one funtypes reported.
function getIntersectChildNode(intersectCodec: ReflectedCodec, node: ValueNode, segment: string | number) {
	const candidates = getChildCodecs(intersectCodec, 'intersectees').flatMap((intersectee) => {
		const child = getChildNode({ ...node, codec: intersectee }, segment)
		return child === undefined ? [] : [child]
	})
	if (candidates.length <= 1) return candidates[0]
	return candidates.find((candidate) => !candidate.codec.safeParse(candidate.value).success) ?? candidates[0]
}

// The child of a node addressed by one failure key segment, without validating any value.
function getChildNode(node: ValueNode, segment: string | number): ValueNode | undefined {
	const codec = unwrapCodec(node.codec)
	const { value, path } = node
	switch (codec.tag) {
		case 'intersect': return getIntersectChildNode(codec, node, segment)
		case 'object': {
			if (typeof segment !== 'string' || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
			const fieldCodec = getFieldCodec(codec, segment)
			return fieldCodec === undefined ? undefined : { codec: fieldCodec, value: getOwnProperty(value, segment), path: [...path, segment] }
		}
		case 'record': {
			const entryCodec = getChildCodec(codec, 'value')
			if (typeof segment !== 'string' || entryCodec === undefined || typeof value !== 'object' || value === null) return undefined
			// funtypes does not escape '.' in record keys, so a segment that is not an own key comes from a mis-split key like "a.b"; stop here and explain the record itself.
			if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined
			return { codec: entryCodec, value: getOwnProperty(value, segment), path: [...path, segment] }
		}
		case 'tuple': {
			if (typeof segment !== 'number' || !Array.isArray(value)) return undefined
			const component = getChildCodecs(codec, 'components')[segment]
			if (component === undefined) return undefined
			return { codec: component, value: value[segment], path: [...path, segment] }
		}
		case 'array': {
			const element = getChildCodec(codec, 'element')
			if (typeof segment !== 'number' || element === undefined || !Array.isArray(value)) return undefined
			return { codec: element, value: value[segment], path: [...path, segment] }
		}
		default: return undefined
	}
}

// funtypes does not escape '.' in record keys and reports the first failing entry in key order, so when several own keys prefix the failure key the first one whose entry fails is the reported one.
function splitRecordFailureKey(recordCodec: ReflectedCodec, recordValue: object, key: string) {
	const candidateKeys = Object.keys(recordValue).filter((ownKey) => key === ownKey || key.startsWith(`${ ownKey }.`))
	const entryCodec = getChildCodec(recordCodec, 'value')
	const recordKey = candidateKeys.length <= 1 || entryCodec === undefined
		? candidateKeys[0]
		: candidateKeys.find((candidateKey) => !entryCodec.safeParse(getOwnProperty(recordValue, candidateKey)).success) ?? candidateKeys[0]
	if (recordKey === undefined) return undefined
	return { segment: recordKey, remainingKey: key.length === recordKey.length ? undefined : key.slice(recordKey.length + 1) }
}

function splitNodeFailureKey(node: ValueNode, key: string | undefined) {
	const codec = unwrapCodec(node.codec)
	if (key !== undefined && codec.tag === 'record' && typeof node.value === 'object' && node.value !== null) return splitRecordFailureKey(codec, node.value, key)
	return splitFailureKey(key)
}

// Walks the failure key down to the innermost failing value without validating the values in between, then explains the failure there.
function locateValueProblem(node: ValueNode, failure: ValueFailure): ValueProblem {
	let failingNode = node
	let remainingKey = failure.key
	for (let split = splitNodeFailureKey(failingNode, remainingKey); split !== undefined; split = splitNodeFailureKey(failingNode, remainingKey)) {
		const child = getChildNode(failingNode, split.segment)
		if (child === undefined) break
		failingNode = child
		remainingKey = split.remainingKey
	}
	// funtypes keeps the innermost message while prefixing the key, so the message also describes the failure of the innermost node.
	return explainFailure(failingNode, { message: failure.message, key: remainingKey })
}

const locateProblemIfInvalid = (node: ValueNode) => {
	const parseResult = node.codec.safeParse(node.value)
	return parseResult.success ? undefined : locateValueProblem(node, parseResult)
}

function explainJsonDocumentFailure(node: ValueNode, text: string, document: JsonDocumentDescription, failure: ValueFailure): ValueProblem {
	const decodedDocument = decodeJsonDocument(text)
	if (!decodedDocument.success) return { kind: 'invalidJsonDocument', path: node.path, document, documentProblem: undefined }
	const documentProblem = locateProblemIfInvalid({ codec: document.codec, value: decodedDocument.value, path: [] })
	if (documentProblem === undefined) return { kind: 'rejected', path: node.path, reason: failure.message }
	return { kind: 'invalidJsonDocument', path: node.path, document, documentProblem }
}

// Explains why a node failed when its failure key cannot be followed any further. Only codecs that may contain the cause are validated, each at most once.
function explainFailure(node: ValueNode, failure: ValueFailure): ValueProblem {
	const { codec, value, path } = node
	if (value === undefined) return { kind: 'missing', path }
	const knownDescription = KNOWN_CODEC_DESCRIPTIONS.get(codec)
	if (knownDescription?.jsonDocument !== undefined && typeof value === 'string') return explainJsonDocumentFailure(node, value, knownDescription.jsonDocument, failure)
	const wrongFormat: ValueProblem = { kind: 'wrongFormat', path, codec, received: value }
	if (knownDescription?.expected !== undefined || !acceptsValueShape(codec, value)) return wrongFormat
	const rejected: ValueProblem = { kind: 'rejected', path, reason: failure.message }
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return locateProblemIfInvalid({ codec: underlying, value, path }) ?? rejected
	switch (codec.tag) {
		case 'intersect': {
			for (const intersectee of getChildCodecs(codec, 'intersectees')) {
				const problem = locateProblemIfInvalid({ codec: intersectee, value, path })
				if (problem !== undefined) return problem
			}
			return rejected
		}
		case 'union': {
			// Only descend into an alternative when it is the single one accepting this shape of value, for example the address in `address | null`.
			const candidates = getChildCodecs(codec, 'alternatives').filter((alternative) => acceptsValueShape(alternative, value))
			const [onlyCandidate] = candidates
			if (candidates.length !== 1 || onlyCandidate === undefined) return wrongFormat
			return locateProblemIfInvalid({ codec: onlyCandidate, value, path }) ?? wrongFormat
		}
		case 'object':
		case 'record':
		case 'tuple':
		case 'array': return rejected
		default: return wrongFormat
	}
}

const formatValuePath = (path: ValuePath) => path.map((segment, index) => {
	if (typeof segment === 'number') return `[${ segment }]`
	return index === 0 ? segment : `.${ segment }`
}).join('')

const formatValueLocation = (path: ValuePath) => `${ typeof path[0] === 'number' ? 'item' : 'field' } "${ formatValuePath(path) }"`

const formatParameterName = (index: number, parameterCodec: ReflectedCodec) => {
	const label = getParameterLabel(parameterCodec)
	return `parameter ${ index + 1 }${ label === undefined ? '' : ` (${ label })` }`
}

// Describes a problem inside a decoded JSON document, relative to the document root.
function describeDocumentProblem(problem: ValueProblem): string {
	const location = problem.path.length === 0 ? 'the document' : formatValueLocation(problem.path)
	switch (problem.kind) {
		case 'missing': return `missing required ${ location }`
		case 'wrongFormat': return `${ location } must be ${ describeExpectedValue(problem.codec) }, but received ${ describeReceivedValue(problem.received) }`
		case 'rejected': return `${ location }: ${ toSentenceFragment(problem.reason) }`
		case 'invalidJsonDocument': return `${ location } is not valid ${ problem.document.name }`
		default: return assertNever(problem)
	}
}

function describeJsonDocumentProblem(document: JsonDocumentDescription, documentProblem: ValueProblem | undefined) {
	const reason = documentProblem === undefined ? 'the string is not valid JSON' : `the JSON string is not valid ${ document.name } (${ describeDocumentProblem(documentProblem) })`
	return `${ reason }; ${ document.name } must be ${ document.shape }`
}

function formatParameterProblem(method: string, parameterName: string, problem: ValueProblem) {
	const subject = `Invalid ${ method } ${ parameterName }${ problem.path.length === 0 ? '' : ` ${ formatValueLocation(problem.path) }` }`
	switch (problem.kind) {
		case 'missing': return problem.path.length === 0
			? `${ method } is missing required ${ parameterName }.`
			: `Invalid ${ method } ${ parameterName }: missing required ${ formatValueLocation(problem.path) }.`
		case 'wrongFormat': return `${ subject }: expected ${ describeExpectedValue(problem.codec) }, but received ${ describeReceivedValue(problem.received) }.`
		case 'rejected': return `${ subject }: ${ toSentenceFragment(problem.reason) }.`
		case 'invalidJsonDocument': return `${ subject }: ${ describeJsonDocumentProblem(problem.document, problem.documentProblem) }.`
		default: return assertNever(problem)
	}
}

const formatParameterCount = (counts: readonly number[]) => {
	const largestCount = counts[counts.length - 1] ?? 0
	if (largestCount === 0) return 'no parameters'
	return `${ formatAlternatives(counts.map(String)) } parameter${ largestCount === 1 ? '' : 's' }`
}

// Lists parameter labels such as " (address, optional block tag)" when every parameter has a known label.
const formatParameterSignature = (parameterCodecs: readonly ReflectedCodec[], requiredCount: number) => {
	const labels = parameterCodecs.map(getParameterLabel)
	if (labels.length === 0 || labels.some((label) => label === undefined)) return ''
	return ` (${ labels.map((label, index) => index < requiredCount ? label : `optional ${ label }`).join(', ') })`
}

const getParameterTupleVariants = (paramsCodec: ReflectedCodec): readonly (readonly ReflectedCodec[])[] => {
	if (paramsCodec.tag === 'tuple') return [getChildCodecs(paramsCodec, 'components')]
	if (paramsCodec.tag !== 'union') return []
	return getChildCodecs(paramsCodec, 'alternatives').filter((alternative) => alternative.tag === 'tuple').map((alternative) => getChildCodecs(alternative, 'components'))
}

const getRequestParams = (request: InterceptedRequest) => 'params' in request ? request.params : undefined

// Explains invalid params in order: params shape and count, missing required parameters, then the first parameter with the wrong format.
function describeParamsProblem(request: InterceptedRequest, requestCodec: ReflectedCodec, requestCodecFailure: ValueFailure, paramsCodec: ReflectedCodec) {
	const method = request.method
	const params = getRequestParams(request)
	const variants = getParameterTupleVariants(paramsCodec)
	const longestVariant = variants.reduce<readonly ReflectedCodec[] | undefined>((longest, variant) => longest === undefined || variant.length > longest.length ? variant : longest, undefined)
	if (longestVariant === undefined) return undefined
	const expectedCounts = [...new Set(variants.map((variant) => variant.length))].sort((first, second) => first - second)
	const requiredCount = expectedCounts[0] ?? 0
	const signature = formatParameterSignature(longestVariant, requiredCount)
	if (!Array.isArray(params)) {
		const expectedParams = longestVariant.length === 0 ? 'an empty array' : `an array of ${ formatParameterCount(expectedCounts) }`
		const receivedParams = params === undefined ? 'no params were provided' : `received ${ describeReceivedValue(params) }`
		return `${ method } expects params to be ${ expectedParams }${ signature }, but ${ receivedParams }.`
	}
	const matchingVariant = variants.find((variant) => variant.length === params.length)
	if (matchingVariant === undefined) {
		const expectation = `${ formatParameterCount(expectedCounts) }${ signature }, but received ${ params.length }`
		const firstMissingParameter = params.length < requiredCount ? longestVariant[params.length] : undefined
		if (firstMissingParameter === undefined) return `${ method } expects ${ expectation }.`
		return `${ method } is missing required ${ formatParameterName(params.length, firstMissingParameter) }: expected ${ expectation }.`
	}
	const problem = locateValueProblem({ codec: requestCodec, value: request, path: [] }, requestCodecFailure)
	const [requestField, parameterIndex, ...parameterPath] = problem.path
	const parameterCodec = typeof parameterIndex === 'number' ? matchingVariant[parameterIndex] : undefined
	if (requestField !== 'params' || typeof parameterIndex !== 'number' || parameterCodec === undefined) return undefined
	return formatParameterProblem(method, formatParameterName(parameterIndex, parameterCodec), { ...problem, path: parameterPath })
}

function describeInvalidRpcParams(request: InterceptedRequest, requestCodec: SupportedEthereumJsonRpcRequestCodec, requestCodecFailure: ValueFailure) {
	const paramsCodec: ReflectedCodec | undefined = 'params' in requestCodec.fields ? requestCodec.fields.params : undefined
	const paramsProblem = paramsCodec === undefined ? undefined : describeParamsProblem(request, requestCodec, requestCodecFailure, paramsCodec)
	if (paramsProblem !== undefined) return paramsProblem
	// Fall back to the failure of this method's own codec, which is far more specific than the failure of the whole request union.
	const location = requestCodecFailure.key === undefined ? '' : ` at ${ requestCodecFailure.key }`
	return `Invalid ${ request.method } parameters${ location }: ${ toSentenceFragment(requestCodecFailure.message) }.`
}

// Invalid-params reply for a supported method whose request failed to parse with that method's own codec.
export function getInvalidRpcParamsReply(request: InterceptedRequest, requestCodec: SupportedEthereumJsonRpcRequestCodec, requestCodecFailure: funtypes.Failure): RPCReply {
	return {
		type: 'result',
		method: request.method,
		error: {
			code: JSON_RPC_ERROR_CODE_INVALID_PARAMS,
			message: describeInvalidRpcParams(request, requestCodec, requestCodecFailure),
		},
	}
}
