// Explains funtypes validation failures by reading codecs and failures through funtypes internals that are not part of its documented API: the codec `tag` names, the `underlying`, `fields`, `alternatives`, `components`, `intersectees`, `element` and `value` members, and the grammar of `Failure.key`. It is written against the exact funtypes version pinned in package.json, and test/tests/funtypesFailureExplanation.test.ts fails when a funtypes upgrade changes these internals.
import type * as funtypes from 'funtypes'

// The part of a funtypes codec that every codec exposes. Tag-specific reflection members such as `fields` or `alternatives` are read through the runtime-validated accessors below.
export type ReflectedCodec = {
	readonly tag: string
	safeParse(value: unknown): funtypes.Result<unknown>
}

// A funtypes failure of one codec for one value. The key is the path from that value to the failing value, for example `params.[0].to`.
export type ValueFailure = {
	readonly message: string
	readonly key?: string
}

export type ValuePath = readonly (string | number)[]

// Counts the validations one explanation has requested, including those skipped after the budget ran out. Only getFailureWithinBudget increments it.
export type ValidationBudget = { validationCount: number }

// The codec descriptions and the validation budget shared by every step of one explanation.
export type ExplanationContext = {
	readonly descriptions: CodecDescriptions
	readonly budget: ValidationBudget
}

// A JSON document held in a string. Create it with describeJsonDocument, which keeps the document codec private to the module that defines it.
export type JsonDocumentDescription = {
	readonly name: string
	readonly shape: string
	readonly locateDocumentProblem: (context: ExplanationContext, text: string) => { readonly isJson: false } | { readonly isJson: true, readonly problem: ValueProblem | undefined }
}

// How readable errors name a codec and describe the values it accepts. Each description is defined beside the codec it describes.
export type CodecDescription = {
	readonly codec: ReflectedCodec
	readonly label: string
	// Codecs with an expectation are reported as a whole instead of being inspected structurally.
	readonly expected?: string
	// Strings that hold a JSON document are explained inside the decoded document.
	readonly jsonDocument?: JsonDocumentDescription
}

export type CodecDescriptions = ReadonlyMap<ReflectedCodec, CodecDescription>

// Why a value failed, located at the innermost failing value. Paths are relative to the explained value.
export type ValueProblem =
	| { readonly kind: 'missing', readonly path: ValuePath }
	| { readonly kind: 'wrongFormat', readonly path: ValuePath, readonly expected: string, readonly received: unknown }
	| { readonly kind: 'rejected', readonly path: ValuePath, readonly reason: string }
	// documentProblem is undefined when the string is not JSON at all.
	| { readonly kind: 'invalidJsonDocument', readonly path: ValuePath, readonly document: JsonDocumentDescription, readonly documentProblem: ValueProblem | undefined }

// funtypes drops the failure key at unions, so every union the explanation descends into validates the remaining subtree again, which is quadratic in the nesting depth of recursive values such as EIP-712 messages. Capping the validations keeps an explanation within a fixed multiple of one parse of the value.
const MAX_EXPLANATION_VALIDATIONS = 16

// Codec tags that validate a value with their `underlying` codec before applying their own check. Lazy codecs store a function that returns the underlying codec.
const WRAPPER_CODEC_TAGS = new Set(['constraint', 'parsed', 'sealed', 'named', 'lazy'])

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

// The codec of a field declared by an object codec, or undefined when the codec is not an object codec or does not declare the field.
export const getObjectFieldCodec = (codec: ReflectedCodec, fieldName: string) => {
	if (codec.tag !== 'object') return undefined
	const fields: unknown = Reflect.get(codec, 'fields')
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

export const formatAlternatives = (alternatives: readonly string[]) => {
	if (alternatives.length <= 1) return alternatives.join('')
	return `${ alternatives.slice(0, -1).join(', ') } or ${ alternatives[alternatives.length - 1] }`
}

const formatLiteral = (value: unknown) => value === undefined ? 'undefined' : JSON.stringify(value)

function describeExpectedValue(descriptions: CodecDescriptions, codec: ReflectedCodec): string {
	const knownExpectation = descriptions.get(codec)?.expected
	if (knownExpectation !== undefined) return knownExpectation
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return describeExpectedValue(descriptions, underlying)
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
		case 'union': return formatAlternatives([...new Set(getChildCodecs(codec, 'alternatives').map((alternative) => describeExpectedValue(descriptions, alternative)))])
		default: return 'a valid value'
	}
}

// A short name for the values a codec accepts, such as "address" or "string", or undefined when the codec has none.
export function getCodecLabel(descriptions: CodecDescriptions, codec: ReflectedCodec): string | undefined {
	const knownLabel = descriptions.get(codec)?.label
	if (knownLabel !== undefined) return knownLabel
	const underlying = getUnderlyingCodec(codec)
	if (underlying !== undefined) return getCodecLabel(descriptions, underlying)
	switch (codec.tag) {
		case 'string':
		case 'number':
		case 'boolean': return codec.tag
		default: return undefined
	}
}

// The item codecs of each array shape a codec accepts: the components of a tuple, or of every tuple in a union of tuples.
export const getTupleVariants = (codec: ReflectedCodec): readonly (readonly ReflectedCodec[])[] => {
	if (codec.tag === 'tuple') return [getChildCodecs(codec, 'components')]
	if (codec.tag !== 'union') return []
	return getChildCodecs(codec, 'alternatives').filter((alternative) => alternative.tag === 'tuple').map((alternative) => getChildCodecs(alternative, 'components'))
}

export const indexCodecDescriptions = (descriptions: readonly CodecDescription[]): CodecDescriptions => new Map(descriptions.map((description) => [description.codec, description]))

const isBudgetExhausted = (budget: ValidationBudget) => budget.validationCount > MAX_EXPLANATION_VALIDATIONS

// The failure of a value, or undefined when it is valid. Once the budget is exhausted the value is not validated and undefined is returned so that the explanation stops descending; explainValueFailure then discards the explanation.
function getFailureWithinBudget(context: ExplanationContext, codec: ReflectedCodec, value: unknown): ValueFailure | undefined {
	context.budget.validationCount += 1
	if (isBudgetExhausted(context.budget)) return undefined
	const parseResult = codec.safeParse(value)
	return parseResult.success ? undefined : parseResult
}

type ValueNode = {
	readonly codec: ReflectedCodec
	readonly value: unknown
	readonly path: ValuePath
}

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
function getIntersectChildNode(context: ExplanationContext, intersectCodec: ReflectedCodec, node: ValueNode, segment: string | number) {
	const candidates = getChildCodecs(intersectCodec, 'intersectees').flatMap((intersectee) => {
		const child = getChildNode(context, { ...node, codec: intersectee }, segment)
		return child === undefined ? [] : [child]
	})
	if (candidates.length <= 1) return candidates[0]
	return candidates.find((candidate) => getFailureWithinBudget(context, candidate.codec, candidate.value) !== undefined) ?? candidates[0]
}

// The child of a node addressed by one failure key segment. Only intersections with several candidate children validate them.
function getChildNode(context: ExplanationContext, node: ValueNode, segment: string | number): ValueNode | undefined {
	const codec = unwrapCodec(node.codec)
	const { value, path } = node
	switch (codec.tag) {
		case 'intersect': return getIntersectChildNode(context, codec, node, segment)
		case 'object': {
			if (typeof segment !== 'string' || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
			const fieldCodec = getObjectFieldCodec(codec, segment)
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
function splitRecordFailureKey(context: ExplanationContext, recordCodec: ReflectedCodec, recordValue: object, key: string) {
	const candidateKeys = Object.keys(recordValue).filter((ownKey) => key === ownKey || key.startsWith(`${ ownKey }.`))
	const entryCodec = getChildCodec(recordCodec, 'value')
	const recordKey = candidateKeys.length <= 1 || entryCodec === undefined
		? candidateKeys[0]
		: candidateKeys.find((candidateKey) => getFailureWithinBudget(context, entryCodec, getOwnProperty(recordValue, candidateKey)) !== undefined) ?? candidateKeys[0]
	if (recordKey === undefined) return undefined
	return { segment: recordKey, remainingKey: key.length === recordKey.length ? undefined : key.slice(recordKey.length + 1) }
}

function splitNodeFailureKey(context: ExplanationContext, node: ValueNode, key: string | undefined) {
	const codec = unwrapCodec(node.codec)
	if (key !== undefined && codec.tag === 'record' && typeof node.value === 'object' && node.value !== null) return splitRecordFailureKey(context, codec, node.value, key)
	return splitFailureKey(key)
}

// Walks the failure key down to the innermost failing value without validating the values in between, then explains the failure there.
function locateValueProblem(context: ExplanationContext, node: ValueNode, failure: ValueFailure): ValueProblem {
	let failingNode = node
	let remainingKey = failure.key
	for (let split = splitNodeFailureKey(context, failingNode, remainingKey); split !== undefined; split = splitNodeFailureKey(context, failingNode, remainingKey)) {
		const child = getChildNode(context, failingNode, split.segment)
		if (child === undefined) break
		failingNode = child
		remainingKey = split.remainingKey
	}
	// funtypes keeps the innermost message while prefixing the key, so the message also describes the failure of the innermost node.
	return explainFailure(context, failingNode, { message: failure.message, key: remainingKey })
}

const locateProblemIfInvalid = (context: ExplanationContext, node: ValueNode) => {
	const failure = getFailureWithinBudget(context, node.codec, node.value)
	return failure === undefined ? undefined : locateValueProblem(context, node, failure)
}

function explainJsonDocumentFailure(context: ExplanationContext, node: ValueNode, text: string, document: JsonDocumentDescription, failure: ValueFailure): ValueProblem {
	const documentExplanation = document.locateDocumentProblem(context, text)
	if (!documentExplanation.isJson) return { kind: 'invalidJsonDocument', path: node.path, document, documentProblem: undefined }
	if (documentExplanation.problem === undefined) return { kind: 'rejected', path: node.path, reason: failure.message }
	return { kind: 'invalidJsonDocument', path: node.path, document, documentProblem: documentExplanation.problem }
}

// Explains why a node failed when its failure key cannot be followed any further. Only codecs that may contain the cause are validated, each at most once.
function explainFailure(context: ExplanationContext, node: ValueNode, failure: ValueFailure): ValueProblem {
	const { codec, value, path } = node
	if (value === undefined) return { kind: 'missing', path }
	const description = context.descriptions.get(codec)
	if (description?.jsonDocument !== undefined && typeof value === 'string') return explainJsonDocumentFailure(context, node, value, description.jsonDocument, failure)
	const wrongFormat = (): ValueProblem => ({ kind: 'wrongFormat', path, expected: describeExpectedValue(context.descriptions, codec), received: value })
	if (description?.expected !== undefined || !acceptsValueShape(codec, value)) return wrongFormat()
	const rejected: ValueProblem = { kind: 'rejected', path, reason: failure.message }
	const underlying = getUnderlyingCodec(codec)
	// A lazy codec validates with its underlying codec and has no check of its own, so this failure already is the failure of the underlying codec.
	if (underlying !== undefined && codec.tag === 'lazy') return explainFailure(context, { codec: underlying, value, path }, failure)
	if (underlying !== undefined) return locateProblemIfInvalid(context, { codec: underlying, value, path }) ?? rejected
	switch (codec.tag) {
		case 'intersect': {
			for (const intersectee of getChildCodecs(codec, 'intersectees')) {
				const problem = locateProblemIfInvalid(context, { codec: intersectee, value, path })
				if (problem !== undefined) return problem
			}
			return rejected
		}
		case 'union': {
			// Only descend into an alternative when it is the single one accepting this shape of value, for example the address in `address | null`.
			const candidates = getChildCodecs(codec, 'alternatives').filter((alternative) => acceptsValueShape(alternative, value))
			const [onlyCandidate] = candidates
			if (candidates.length !== 1 || onlyCandidate === undefined) return wrongFormat()
			return locateProblemIfInvalid(context, { codec: onlyCandidate, value, path }) ?? wrongFormat()
		}
		case 'object':
		case 'record':
		case 'tuple':
		case 'array': return rejected
		default: return wrongFormat()
	}
}

// Decodes a JSON document with the document's own parser, which throws a SyntaxError for text that is not JSON.
function decodeJsonDocument(parse: (text: string) => unknown, text: string): { readonly success: true, readonly value: unknown } | { readonly success: false } {
	try {
		return { success: true, value: parse(text) }
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return { success: false }
		throw error
	}
}

// Describes strings that hold a JSON document, such as EIP-712 typed data. The document codec is only captured by the returned explanation, so the module defining it does not have to export it.
export function describeJsonDocument(document: { readonly name: string, readonly shape: string, readonly codec: ReflectedCodec, readonly parse: (text: string) => unknown }): JsonDocumentDescription {
	const { name, shape, codec, parse } = document
	return {
		name,
		shape,
		locateDocumentProblem: (context, text) => {
			const decodedDocument = decodeJsonDocument(parse, text)
			if (!decodedDocument.success) return { isJson: false }
			return { isJson: true, problem: locateProblemIfInvalid(context, { codec, value: decodedDocument.value, path: [] }) }
		},
	}
}

// Explains why a value failed to parse with a codec, given that codec's failure for the value. Returns undefined when the explanation needs more validations than the budget allows, so the caller reports the funtypes failure as it is.
export function explainValueFailure(descriptions: CodecDescriptions, codec: ReflectedCodec, value: unknown, failure: ValueFailure): ValueProblem | undefined {
	const context: ExplanationContext = { descriptions, budget: { validationCount: 0 } }
	const problem = locateValueProblem(context, { codec, value, path: [] }, failure)
	// Skipped validations may have left the explanation pointing at a valid value.
	return isBudgetExhausted(context.budget) ? undefined : problem
}
