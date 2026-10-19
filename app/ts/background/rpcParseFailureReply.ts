import type * as funtypes from 'funtypes'
import type { RPCReply } from '../types/interceptor-messages.js'
import { EthGetLogsRequestDescription, PartialEthereumTransactionDescription, type SupportedEthereumJsonRpcRequestCodec } from '../types/JsonRpc-types.js'
import { EthSimulateV1BlockTagDescription } from '../types/ethSimulate-types.js'
import { EIP712MessageDescription } from '../types/eip721.js'
import { CanonicalEthereumQuantityDescription, EthereumAddressDescription, EthereumBlockTagDescription, EthereumBytes32Description, EthereumDataDescription, EthereumInputDescription, EthereumQuantityDescription } from '../types/wire-types.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { explainValueFailure, formatAlternatives, getCodecLabel, getObjectFieldCodec, getTupleVariants, indexCodecDescriptions, type ReflectedCodec, type ValueFailure, type ValuePath, type ValueProblem } from '../utils/funtypesFailureExplanation.js'
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

// Codecs that invalid-params errors name and describe by their meaning instead of their structure. Each description is defined beside its codec.
const CODEC_DESCRIPTIONS = indexCodecDescriptions([
	EthereumAddressDescription,
	EthereumQuantityDescription,
	CanonicalEthereumQuantityDescription,
	EthereumBlockTagDescription,
	EthSimulateV1BlockTagDescription,
	EthereumBytes32Description,
	EthereumDataDescription,
	EthereumInputDescription,
	EIP712MessageDescription,
	PartialEthereumTransactionDescription,
	EthGetLogsRequestDescription,
])

const MAX_ECHOED_STRING_LENGTH = 80
const MAX_REASON_LENGTH = 200

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

const formatValuePath = (path: ValuePath) => path.map((segment, index) => {
	if (typeof segment === 'number') return `[${ segment }]`
	return index === 0 ? segment : `.${ segment }`
}).join('')

const formatValueLocation = (path: ValuePath) => `${ typeof path[0] === 'number' ? 'item' : 'field' } "${ formatValuePath(path) }"`

const formatParameterName = (index: number, parameterCodec: ReflectedCodec) => {
	const label = getCodecLabel(CODEC_DESCRIPTIONS, parameterCodec)
	return `parameter ${ index + 1 }${ label === undefined ? '' : ` (${ label })` }`
}

// Describes a problem inside a decoded JSON document, relative to the document root.
function describeDocumentProblem(problem: ValueProblem): string {
	const location = problem.path.length === 0 ? 'the document' : formatValueLocation(problem.path)
	switch (problem.kind) {
		case 'missing': return `missing required ${ location }`
		case 'wrongFormat': return `${ location } must be ${ problem.expected }, but received ${ describeReceivedValue(problem.received) }`
		case 'rejected': return `${ location }: ${ toSentenceFragment(problem.reason) }`
		case 'invalidJsonDocument': return `${ location } is not valid ${ problem.document.name }`
		default: return assertNever(problem)
	}
}

function describeJsonDocumentProblem(document: { readonly name: string, readonly shape: string }, documentProblem: ValueProblem | undefined) {
	const reason = documentProblem === undefined ? 'the string is not valid JSON' : `the JSON string is not valid ${ document.name } (${ describeDocumentProblem(documentProblem) })`
	return `${ reason }; ${ document.name } must be ${ document.shape }`
}

function formatParameterProblem(method: string, parameterName: string, problem: ValueProblem) {
	const subject = `Invalid ${ method } ${ parameterName }${ problem.path.length === 0 ? '' : ` ${ formatValueLocation(problem.path) }` }`
	switch (problem.kind) {
		case 'missing': return problem.path.length === 0
			? `${ method } is missing required ${ parameterName }.`
			: `Invalid ${ method } ${ parameterName }: missing required ${ formatValueLocation(problem.path) }.`
		case 'wrongFormat': return `${ subject }: expected ${ problem.expected }, but received ${ describeReceivedValue(problem.received) }.`
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
	const labels = parameterCodecs.map((parameterCodec) => getCodecLabel(CODEC_DESCRIPTIONS, parameterCodec))
	if (labels.length === 0 || labels.some((label) => label === undefined)) return ''
	return ` (${ labels.map((label, index) => index < requiredCount ? label : `optional ${ label }`).join(', ') })`
}

const getRequestParams = (request: InterceptedRequest) => 'params' in request ? request.params : undefined

// Explains invalid params in order: params shape and count, missing required parameters, then the first parameter with the wrong format.
function describeParamsProblem(request: InterceptedRequest, requestCodec: ReflectedCodec, requestCodecFailure: ValueFailure, paramsCodec: ReflectedCodec) {
	const method = request.method
	const params = getRequestParams(request)
	const variants = getTupleVariants(paramsCodec)
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
	const problem = explainValueFailure(CODEC_DESCRIPTIONS, requestCodec, request, requestCodecFailure)
	// The explanation is undefined when it ran out of its validation budget; describeInvalidRpcParams then reports the method codec failure instead.
	if (problem === undefined) return undefined
	const [requestField, parameterIndex, ...parameterPath] = problem.path
	const parameterCodec = typeof parameterIndex === 'number' ? matchingVariant[parameterIndex] : undefined
	if (requestField !== 'params' || typeof parameterIndex !== 'number' || parameterCodec === undefined) return undefined
	return formatParameterProblem(method, formatParameterName(parameterIndex, parameterCodec), { ...problem, path: parameterPath })
}

function describeInvalidRpcParams(request: InterceptedRequest, requestCodec: SupportedEthereumJsonRpcRequestCodec, requestCodecFailure: ValueFailure) {
	const paramsCodec = getObjectFieldCodec(requestCodec, 'params')
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
