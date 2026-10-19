import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import * as funtypes from 'funtypes'
import { type CodecDescriptions, describeJsonDocument, explainValueFailure, getCodecLabel, getObjectFieldCodec, getTupleVariants, indexCodecDescriptions, type ReflectedCodec } from '../../app/ts/utils/funtypesFailureExplanation.js'

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
		const jsonDocument = describeJsonDocument({ name: 'settings', shape: 'a JSON object with a version', codec: Settings, parse: JSON.parse })
		const descriptions = indexCodecDescriptions([{ codec: SettingsText, label: 'settings', expected: 'settings as a JSON string', jsonDocument }])
		const codec = funtypes.ReadonlyTuple(SettingsText)
		assert.deepEqual(explain(codec, ['{"version":"1"}'], descriptions), { kind: 'invalidJsonDocument', path: [0], document: jsonDocument, documentProblem: { kind: 'wrongFormat', path: ['version'], expected: 'a number', received: '1' } })
		assert.deepEqual(explain(codec, ['{"version":'], descriptions), { kind: 'invalidJsonDocument', path: [0], document: jsonDocument, documentProblem: undefined })
		assert.deepEqual(explain(codec, ['{"version":1}'], descriptions), { kind: 'rejected', path: [0], reason: 'is not settings JSON' })
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
})
