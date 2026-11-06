import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import * as funtypes from 'funtypes'
import { CODEC_DESCRIPTIONS } from '../../app/ts/background/rpcParseFailureReply.js'
import { EthereumJsonRpcRequest, WalletRevokePermissions } from '../../app/ts/types/JsonRpc-types.js'
import { CODEC_TAGS_BY_HANDLING, type CodecDescriptions, explainValueFailure, getCodecLabel, getObjectFieldCodec, getTupleVariants, indexCodecDescriptions, isReflectedCodec, type ValueProblem } from '../../app/ts/background/funtypesFailureExplanation.js'
import type { ReflectedCodec } from '../../app/ts/types/codecDescription.js'

// These tests pin the funtypes internals the adapter reads, so a funtypes upgrade that changes them fails here instead of silently degrading invalid-params errors.

const noDescriptions = indexCodecDescriptions([])

function explain(codec: ReflectedCodec, value: unknown, descriptions: CodecDescriptions = noDescriptions) {
	const parseResult = codec.safeParse(value)
	if (parseResult.success) throw new Error('The value should fail to parse')
	return explainValueFailure(descriptions, codec, value, parseResult)
}

const EvenLengthString = funtypes.String.withParser({
	parse: (value) => value.length % 2 === 0 ? { success: true, value } : { success: false, message: `${ value } has an odd length` },
})

type NestedValue = string | { readonly [key: string]: NestedValue | undefined }
const NestedValue: funtypes.Runtype<NestedValue> = funtypes.Lazy(() => NestedValueUnion)
const NestedValueRecord = funtypes.ReadonlyRecord(funtypes.String, NestedValue)
const NestedValueUnion = funtypes.Union(funtypes.String, NestedValueRecord)

// Objects nested `depth` levels deep through their `next` field, ending in a JSON null that NestedValue does not accept.
const createNestedValue = (depth: number): unknown => JSON.parse(`${ '{"next":'.repeat(depth) }null${ '}'.repeat(depth) }`)

// Counts the validations of the union and record codecs inside NestedValue while a nested value is explained.
function explainNestedValueWithParseCount(depth: number) {
	const parseSpies = [spyOn(NestedValueUnion, 'safeParse'), spyOn(NestedValueRecord, 'safeParse')]
	try {
		const value = createNestedValue(depth)
		const parseResult = NestedValue.safeParse(value)
		if (parseResult.success) throw new Error('The nested value should fail to parse')
		for (const parseSpy of parseSpies) parseSpy.mockClear()
		const problem = explainValueFailure(noDescriptions, NestedValue, value, parseResult)
		return { problem, parseCount: parseSpies.reduce((total, parseSpy) => total + parseSpy.mock.calls.length, 0) }
	} finally {
		for (const parseSpy of parseSpies) parseSpy.mockRestore()
	}
}

const Counter = funtypes.ReadonlyObject({ count: funtypes.Number })
const OptionalLabel = funtypes.ReadonlyPartial({ label: funtypes.String })
const DiscriminatedObject = funtypes.Union(funtypes.ReadonlyObject({ type: funtypes.Literal('a'), count: funtypes.Number }), funtypes.ReadonlyObject({ type: funtypes.Literal('b') }))
const DiscriminatedTuple = funtypes.Union(funtypes.ReadonlyTuple(funtypes.Literal('a'), funtypes.Number), funtypes.ReadonlyTuple(funtypes.Literal('b')))
const NoneLiteral = funtypes.Literal('none')
const ConstrainedCounter = Counter.withConstraint(() => true)
const ParsedCounter = Counter.withParser({ parse: (value) => ({ success: true, value }) })
const SealedCounter = funtypes.Sealed(Counter)
const NamedCounter = funtypes.Named('Counter', Counter)
const LazyCounter = funtypes.Lazy(() => Counter)
const IntersectedCounter = funtypes.Intersect(Counter, OptionalLabel)
const CounterOrNone = funtypes.Union(NoneLiteral, Counter)

const wrongCount: ValueProblem = { kind: 'wrongFormat', path: ['count'], expected: 'a number', received: 'x' }
const wrongFirstItem: ValueProblem = { kind: 'wrongFormat', path: [0], expected: 'a number', received: 'x' }
const wrongTopLevelValue = (expected: string, received: unknown): ValueProblem => ({ kind: 'wrongFormat', path: [], expected, received })
const opaqueLeafSample = (codec: ReflectedCodec) => ({ codec, value: 0, problem: wrongTopLevelValue('a valid value', 0) })

// One codec of every funtypes tag, with the problem the module explains for a value of it.
const CODEC_SAMPLES: readonly { readonly codec: ReflectedCodec, readonly value: unknown, readonly problem: ValueProblem }[] = [
	{ codec: ConstrainedCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: ParsedCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: SealedCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: NamedCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: LazyCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: Counter, value: { count: 'x' }, problem: wrongCount },
	{ codec: funtypes.ReadonlyRecord(funtypes.String, funtypes.Number), value: { count: 'x' }, problem: wrongCount },
	{ codec: funtypes.ReadonlyTuple(funtypes.Number), value: ['x'], problem: wrongFirstItem },
	{ codec: funtypes.ReadonlyArray(funtypes.Number), value: ['x'], problem: wrongFirstItem },
	{ codec: IntersectedCounter, value: { count: 'x' }, problem: wrongCount },
	{ codec: CounterOrNone, value: { count: 'x' }, problem: wrongCount },
	{ codec: funtypes.String, value: 0, problem: wrongTopLevelValue('a string', 0) },
	{ codec: funtypes.Number, value: 'x', problem: wrongTopLevelValue('a number', 'x') },
	{ codec: funtypes.Boolean, value: 0, problem: wrongTopLevelValue('a boolean', 0) },
	{ codec: NoneLiteral, value: 0, problem: wrongTopLevelValue('"none"', 0) },
	{ codec: funtypes.Never, value: 0, problem: wrongTopLevelValue('no value', 0) },
	opaqueLeafSample(funtypes.Unknown),
	opaqueLeafSample(funtypes.BigInt),
	opaqueLeafSample(funtypes.Symbol),
	opaqueLeafSample(funtypes.Function),
	opaqueLeafSample(funtypes.Enum('Color', { Red: 'red' })),
	opaqueLeafSample(funtypes.KeyOf({ red: 1 })),
	opaqueLeafSample(funtypes.InstanceOf(Date)),
	opaqueLeafSample(funtypes.Brand('Name', funtypes.String)),
]

// The members the module reads, with what each one holds for a codec built from known parts. Lazy codecs are pinned separately because their member is a function.
const REFLECTED_MEMBERS: readonly { readonly codec: ReflectedCodec, readonly member: string, readonly holds: unknown }[] = [
	{ codec: ConstrainedCounter, member: 'underlying', holds: Counter },
	{ codec: ParsedCounter, member: 'underlying', holds: Counter },
	{ codec: SealedCounter, member: 'underlying', holds: Counter },
	{ codec: NamedCounter, member: 'underlying', holds: Counter },
	{ codec: Counter, member: 'fields', holds: { count: funtypes.Number } },
	{ codec: funtypes.ReadonlyRecord(funtypes.String, Counter), member: 'value', holds: Counter },
	{ codec: funtypes.ReadonlyTuple(Counter, funtypes.String), member: 'components', holds: [Counter, funtypes.String] },
	{ codec: funtypes.ReadonlyArray(Counter), member: 'element', holds: Counter },
	{ codec: IntersectedCounter, member: 'intersectees', holds: [Counter, OptionalLabel] },
	{ codec: CounterOrNone, member: 'alternatives', holds: [NoneLiteral, Counter] },
	{ codec: NoneLiteral, member: 'value', holds: 'none' },
]

// The keys funtypes reports. splitFailureKey and splitRecordFailureKey parse this grammar, and each wrapper has to pass the key of its underlying codec through.
const FAILURE_KEYS: readonly { readonly codec: ReflectedCodec, readonly value: unknown, readonly key: string | undefined }[] = [
	{ codec: Counter, value: {}, key: 'count' },
	{ codec: funtypes.ReadonlyObject({ nested: Counter }), value: { nested: { count: 'x' } }, key: 'nested.count' },
	{ codec: funtypes.ReadonlyTuple(Counter), value: [{ count: 'x' }], key: '[0].count' },
	{ codec: funtypes.ReadonlyTuple(Counter), value: [], key: undefined },
	{ codec: funtypes.ReadonlyArray(funtypes.Number), value: [1, 'x'], key: '[1]' },
	{ codec: funtypes.ReadonlyRecord(funtypes.String, Counter), value: { 'dotted.key': { count: 'x' } }, key: 'dotted.key.count' },
	{ codec: IntersectedCounter, value: { count: 'x' }, key: 'count' },
	{ codec: ConstrainedCounter, value: { count: 'x' }, key: 'count' },
	{ codec: ParsedCounter, value: { count: 'x' }, key: 'count' },
	{ codec: SealedCounter, value: { count: 'x' }, key: 'count' },
	{ codec: SealedCounter, value: { count: 1, extra: 2 }, key: 'extra' },
	{ codec: NamedCounter, value: { count: 'x' }, key: 'count' },
	{ codec: LazyCounter, value: { count: 'x' }, key: 'count' },
	{ codec: CounterOrNone, value: { count: 'x' }, key: undefined },
	{ codec: DiscriminatedObject, value: { type: 'a', count: 'x' }, key: '<type: "a">.count' },
	{ codec: DiscriminatedObject, value: { type: 'c' }, key: 'type' },
	{ codec: DiscriminatedTuple, value: ['a', 'x'], key: '<[0]: "a">.[1]' },
]

// Every codec reachable from the roots. It scans all members instead of naming them, so a changed funtypes layout cannot hide a tag from this walk; only the function of a lazy codec has to be called by name.
function collectReachableCodecs(roots: readonly unknown[]) {
	const codecs = new Set<ReflectedCodec>()
	const visited = new Set<object>()
	const visit = (value: unknown): void => {
		if (typeof value !== 'object' || value === null || visited.has(value)) return
		visited.add(value)
		if (isReflectedCodec(value)) {
			codecs.add(value)
			const lazyUnderlying: unknown = value.tag === 'lazy' ? Reflect.get(value, 'underlying') : undefined
			if (typeof lazyUnderlying === 'function') visit(lazyUnderlying())
		}
		for (const member of Object.values(value)) visit(member)
	}
	for (const root of roots) visit(root)
	return codecs
}

describe('funtypes failure explanation', () => {
	test('follows failure keys through object fields and tuple components', () => {
		const codec = funtypes.ReadonlyObject({ pair: funtypes.ReadonlyTuple(funtypes.Number, funtypes.Number) })
		assert.deepEqual(explain(codec, { pair: [1, 'x'] }), { kind: 'wrongFormat', path: ['pair', 1], expected: 'a number', received: 'x' })
		assert.deepEqual(explain(codec, {}), { kind: 'missing', path: ['pair'] })
		assert.deepEqual(explain(codec, { pair: [1] }), { kind: 'wrongFormat', path: ['pair'], expected: 'an array of 2 items', received: [1] })
	})

	test('follows failure keys through record entries with dotted keys and array elements', () => {
		const codec = funtypes.ReadonlyRecord(funtypes.String, funtypes.ReadonlyArray(funtypes.String))
		assert.deepEqual(explain(codec, { 'a.b': ['ok', 2] }), { kind: 'wrongFormat', path: ['a.b', 1], expected: 'a string', received: 2 })
	})

	test('descends into the only union alternative that accepts the shape of the value', () => {
		const codec = funtypes.Union(funtypes.Literal('none'), funtypes.ReadonlyObject({ enabled: funtypes.Boolean }))
		assert.deepEqual(explain(codec, { enabled: 'yes' }), { kind: 'wrongFormat', path: ['enabled'], expected: 'a boolean', received: 'yes' })
		assert.deepEqual(explain(codec, 5), { kind: 'wrongFormat', path: [], expected: '"none" or an object', received: 5 })
	})

	test('reads the underlying codec of parsed and constrained codecs', () => {
		const PositiveNumber = funtypes.Number.withConstraint((value) => value > 0 || 'must be positive')
		const codec = funtypes.ReadonlyObject({ code: EvenLengthString, count: PositiveNumber })
		assert.deepEqual(explain(codec, { code: 'abc', count: 1 }), { kind: 'rejected', path: ['code'], reason: 'abc has an odd length' })
		assert.deepEqual(explain(codec, { code: 7, count: 1 }), { kind: 'wrongFormat', path: ['code'], expected: 'a string', received: 7 })
		assert.deepEqual(explain(codec, { code: 'ab', count: -1 }), { kind: 'rejected', path: ['count'], reason: 'must be positive' })
	})

	test('explains the intersectee that rejects the value', () => {
		const codec = funtypes.Intersect(funtypes.ReadonlyObject({ name: funtypes.String }), funtypes.ReadonlyPartial({ age: funtypes.Number }))
		assert.deepEqual(explain(codec, { name: 'x', age: 'old' }), { kind: 'wrongFormat', path: ['age'], expected: 'a number', received: 'old' })
		assert.deepEqual(explain(codec, { age: 1 }), { kind: 'missing', path: ['name'] })
	})

	test('uses codec descriptions for expectations and labels', () => {
		const descriptions = indexCodecDescriptions([{ codec: EvenLengthString, label: 'even text', expected: 'text of even length' }])
		assert.deepEqual(explain(funtypes.ReadonlyTuple(EvenLengthString), ['abc'], descriptions), { kind: 'wrongFormat', path: [0], expected: 'text of even length', received: 'abc' })
		assert.equal(getCodecLabel(descriptions, EvenLengthString), 'even text')
		assert.equal(getCodecLabel(noDescriptions, EvenLengthString), 'string')
		assert.equal(getCodecLabel(noDescriptions, funtypes.ReadonlyObject({})), undefined)
	})

	test('lists the item codecs of tuples and unions of tuples', () => {
		assert.deepEqual(getTupleVariants(funtypes.Union(funtypes.ReadonlyTuple(funtypes.String), funtypes.ReadonlyTuple(funtypes.String, funtypes.Number))).map((variant) => variant.length), [1, 2])
		const [onlyVariant] = getTupleVariants(funtypes.ReadonlyTuple(funtypes.Boolean))
		assert.equal(onlyVariant?.[0], funtypes.Boolean)
		assert.deepEqual(getTupleVariants(funtypes.String), [])
	})

	test('reads the declared field codecs of object codecs', () => {
		const NameCodec = funtypes.String.withConstraint((name) => name.length > 0)
		for (const objectCodec of [funtypes.ReadonlyObject({ name: NameCodec }), funtypes.ReadonlyObject({ name: NameCodec }).asReadonly(), funtypes.ReadonlyPartial({ name: NameCodec })]) {
			assert.equal(getObjectFieldCodec(objectCodec, 'name'), NameCodec)
			assert.equal(getObjectFieldCodec(objectCodec, 'missing'), undefined)
			assert.equal(getObjectFieldCodec(objectCodec, 'toString'), undefined)
		}
		assert.equal(getObjectFieldCodec(funtypes.ReadonlyRecord(funtypes.String, NameCodec), 'name'), undefined)
		assert.equal(getObjectFieldCodec(funtypes.ReadonlyTuple(NameCodec), '0'), undefined)
	})

	test('explains strings that hold a JSON document inside the decoded document', () => {
		const Settings = funtypes.ReadonlyObject({ version: funtypes.Number })
		// Rejects every string, so only the explanation decides whether the string holds valid settings.
		const SettingsText = funtypes.String.withConstraint(() => 'is not settings JSON')
		const jsonDocument = { name: 'settings', shape: 'a JSON object with a version', codec: Settings, parse: JSON.parse }
		const descriptions = indexCodecDescriptions([{ codec: SettingsText, label: 'settings', expected: 'settings as a JSON string', jsonDocument }])
		const codec = funtypes.ReadonlyTuple(SettingsText)
		assert.deepEqual(explain(codec, ['{"version":"1"}'], descriptions), { kind: 'invalidJsonDocument', path: [0], document: jsonDocument, documentProblem: { kind: 'wrongFormat', path: ['version'], expected: 'a number', received: '1' } })
		assert.deepEqual(explain(codec, ['{"version":'], descriptions), { kind: 'invalidJsonDocument', path: [0], document: jsonDocument, documentProblem: undefined })
		assert.deepEqual(explain(codec, ['{"version":1}'], descriptions), { kind: 'rejected', path: [0], reason: 'is not settings JSON' })
	})

	test('treats any failure of the document parser as a string that does not decode', () => {
		const Settings = funtypes.ReadonlyObject({ version: funtypes.Number })
		const SettingsText = funtypes.String.withConstraint(() => 'is not settings JSON')
		for (const parseError of [new SyntaxError('not JSON'), new RangeError('Maximum call stack size exceeded'), new Error('parser failed')]) {
			const jsonDocument = { name: 'settings', shape: 'a JSON object', codec: Settings, parse: () => { throw parseError } }
			const descriptions = indexCodecDescriptions([{ codec: SettingsText, label: 'settings', expected: 'settings as a JSON string', jsonDocument }])
			assert.deepEqual(explain(SettingsText, '{}', descriptions), { kind: 'invalidJsonDocument', path: [], document: jsonDocument, documentProblem: undefined })
		}
	})

	test('gives up on a stack overflow, which nesting that a page controls can cause, but not on a programming error', () => {
		const explainDocumentThatThrows = (validationError: Error) => {
			const documentCodec: ReflectedCodec = { tag: 'object', safeParse: () => { throw validationError } }
			const SettingsText = funtypes.String.withConstraint(() => 'is not settings JSON')
			const jsonDocument = { name: 'settings', shape: 'a JSON object', codec: documentCodec, parse: JSON.parse }
			return explain(SettingsText, '{}', indexCodecDescriptions([{ codec: SettingsText, label: 'settings', expected: 'settings as a JSON string', jsonDocument }]))
		}
		assert.equal(explainDocumentThatThrows(new RangeError('Maximum call stack size exceeded')), undefined)
		assert.throws(() => explainDocumentThatThrows(new TypeError('a bug in the explanation')), TypeError)
	})

	test('explains recursive lazy codecs with one validation per nesting level', () => {
		const { problem, parseCount } = explainNestedValueWithParseCount(3)
		assert.deepEqual(problem, { kind: 'wrongFormat', path: ['next', 'next', 'next'], expected: 'a string or an object', received: null })
		assert.equal(parseCount, 3)
	})

	test('gives up once the validation budget is spent instead of validating every nesting level again', () => {
		const shallowlyNested = explainNestedValueWithParseCount(50)
		const deeplyNested = explainNestedValueWithParseCount(400)
		assert.equal(shallowlyNested.problem, undefined)
		assert.equal(deeplyNested.problem, undefined)
		assert.equal(deeplyNested.parseCount, shallowlyNested.parseCount)
	})

	test('classifies every tag met in the RPC request codecs and the documents they hold', () => {
		// Descriptions are roots because a JSON document codec is only reachable through its description, not through the string codec that holds the document.
		const reachableCodecs = collectReachableCodecs([EthereumJsonRpcRequest, WalletRevokePermissions, ...CODEC_DESCRIPTIONS.values()])
		const metTags = new Set([...reachableCodecs].map((codec) => codec.tag))
		const classifiedTags = new Set(Object.values(CODEC_TAGS_BY_HANDLING).flat())
		assert.deepEqual([...metTags].filter((tag) => !classifiedTags.has(tag)), [])
		// Named is the one structural tag the RPC codecs do not use; missing any other means this walk stopped reaching part of the codecs.
		const structuralTags = [...CODEC_TAGS_BY_HANDLING.wrapper, ...CODEC_TAGS_BY_HANDLING.composite].filter((tag) => tag !== 'named')
		assert.deepEqual(structuralTags.filter((tag) => !metTags.has(tag)), [])
		// A branded codec would be explained as an opaque leaf instead of through the codec it wraps, so using one needs unwrapping support first.
		assert.equal(metTags.has('brand'), false)
	})

	test('has a sample of exactly the classified tags', () => {
		const sortedClassifiedTags = Object.values(CODEC_TAGS_BY_HANDLING).flat().sort()
		assert.deepEqual(CODEC_SAMPLES.map(({ codec }) => codec.tag).sort(), sortedClassifiedTags)
	})

	test('explains a value of every classified tag through the branch that handles the tag', () => {
		for (const { codec, value, problem } of CODEC_SAMPLES) {
			const parseResult = codec.safeParse(value)
			// funtypes.Unknown accepts every value, so its failure can only be given.
			const failure = parseResult.success ? { message: 'rejected by an enclosing codec' } : parseResult
			assert.deepEqual(explainValueFailure(noDescriptions, codec, value, failure), problem, codec.tag)
		}
	})

	test('falls back to the generic expectation for a tag it does not classify', () => {
		const futureCodec: ReflectedCodec = { tag: 'futureCodec', safeParse: (value) => funtypes.String.safeParse(value) }
		assert.deepEqual(explain(futureCodec, 0), wrongTopLevelValue('a valid value', 0))
		assert.equal(getCodecLabel(noDescriptions, futureCodec), undefined)
	})

	test('pins the member layout of every codec it descends into', () => {
		for (const { codec, member, holds } of REFLECTED_MEMBERS) assert.deepEqual(Reflect.get(codec, member), holds, `${ codec.tag }.${ member }`)
		const lazyUnderlying: unknown = Reflect.get(LazyCounter, 'underlying')
		assert.equal(typeof lazyUnderlying === 'function' ? lazyUnderlying() : undefined, Counter)
		const pinnedTags = [...REFLECTED_MEMBERS.map(({ codec }) => codec.tag), 'lazy']
		assert.deepEqual(pinnedTags.sort(), [...CODEC_TAGS_BY_HANDLING.wrapper, ...CODEC_TAGS_BY_HANDLING.composite, 'literal'].sort())
	})

	test('pins the failure key grammar', () => {
		for (const { codec, value, key } of FAILURE_KEYS) {
			const parseResult = codec.safeParse(value)
			assert.equal(parseResult.success, false, `${ codec.tag } should reject ${ JSON.stringify(value) }`)
			assert.equal(parseResult.success ? undefined : parseResult.key, key)
		}
	})

	test('keeps the innermost message while prefixing the failure key', () => {
		const innerResult = Counter.safeParse({ count: 'x' })
		const outerResult = funtypes.ReadonlyObject({ nested: Counter }).safeParse({ nested: { count: 'x' } })
		assert.equal(outerResult.success ? undefined : outerResult.message, innerResult.success ? undefined : innerResult.message)
	})

	test('does not follow discriminated union keys', () => {
		const value = { type: 'a', count: 'x' }
		assert.deepEqual(explain(DiscriminatedObject, value), wrongTopLevelValue('an object', value))
	})

	// Living under background/ does not enforce this on its own, because extension pages import other background modules such as backgroundUtils.ts at runtime.
	test('is only loaded at runtime by the invalid-params reply, so extension pages sharing the type modules do not load it', async () => {
		const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
		const runtimeImporters: string[] = []
		for await (const sourceFile of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
			const source = await Bun.file(`${ sourceDirectory }${ sourceFile }`).text()
			if (!source.includes('funtypesFailureExplanation.js')) continue
			// The import scan leaves out erased type imports.
			const runtimeImports = new Bun.Transpiler({ loader: sourceFile.endsWith('.tsx') ? 'tsx' : 'ts' }).scanImports(source)
			if (runtimeImports.some((runtimeImport) => runtimeImport.path.endsWith('funtypesFailureExplanation.js'))) runtimeImporters.push(sourceFile)
		}
		assert.deepEqual(runtimeImporters, ['background/rpcParseFailureReply.ts'])
	})
})
