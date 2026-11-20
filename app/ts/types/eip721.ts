import * as funtypes from 'funtypes'
import { isStackOverflowError } from '../utils/caughtErrors.js'
import { JSONEncodeableObject, jsonParserWithNumbersAsStringsConverter } from '../utils/json.js'
import { EnrichedGroupedSolidityType } from './solidityType.js'
import { EthereumQuantity, NonHexBigInt, serialize } from './wire-types.js'
import type { CodecDescription } from './codecDescription.js'

export type EIP712Types = funtypes.Static<typeof EIP712Types>
export const EIP712Types = funtypes.Record(funtypes.String, funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({ name: funtypes.String, type: funtypes.String })
))

type EIP712MessageUnderlying = funtypes.Static<typeof EIP712MessageUnderlying>
const EIP712MessageUnderlying = funtypes.ReadonlyObject({
	types: EIP712Types,
	primaryType: funtypes.String,
	domain: JSONEncodeableObject,
	message: JSONEncodeableObject,
})

// The one way an EIP-712 typed data string is decoded and checked, used by EIP712Message and by its invalid-params explanation (EIP712MessageDescription), so both agree on which strings are typed data. Decoding throws a SyntaxError for text that is not JSON and a stack overflow error for nesting too deep for the reviver; both are a property of the page's string.
const decodeEIP712MessageJson = (text: string): unknown => jsonParserWithNumbersAsStringsConverter(text)

const EIP712MessageParser: funtypes.ParsedValue<funtypes.String, EIP712MessageUnderlying>['config'] = {
	parse: value => {
		try {
			const decoded = decodeEIP712MessageJson(value)
			if (!EIP712MessageUnderlying.test(decoded)) return { success: false, message: `${ value } is not EIP712 message` }
			return { success: true, value: EIP712MessageUnderlying.parse(decoded) }
		} catch (error: unknown) {
			if (error instanceof SyntaxError) return { success: false, message: `${ value } is not EIP712 message` }
			// Websites control this string, and both the JSON reviver and the codecs recurse once per nesting level.
			if (isStackOverflowError(error)) return { success: false, message: 'EIP712 message is nested too deeply to validate.' }
			throw error
		}
	},
	serialize: value => {
		if (!EIP712MessageUnderlying.test(value)) return { success: false, message: `${ value } is not a EIP712 message.`}
		return { success: true, value: JSON.stringify(serialize(EIP712MessageUnderlying, value)) }
	},
}

export type EIP712Message = funtypes.Static<typeof EIP712Message>
export const EIP712Message = funtypes.String.withParser(EIP712MessageParser)
// How invalid-params errors describe EIP712Message. A string that is not typed data is explained inside its JSON document, decoded with decodeEIP712MessageJson and checked against EIP712MessageUnderlying, exactly as EIP712MessageParser does, so the explanation and the parser agree on what is typed data. The explanation only words a rejection EIP712Message already made; typed data is only ever accepted through EIP712Message. The document codec stays unexported and is reachable only here, as a ReflectedCodec.
export const EIP712MessageDescription: CodecDescription = {
	codec: EIP712Message,
	label: 'typed data',
	expected: 'EIP-712 typed data encoded as a JSON string',
	jsonDocument: { name: 'EIP-712 typed data', shape: 'a JSON object with types, primaryType, domain and message', codec: EIP712MessageUnderlying, parse: decodeEIP712MessageJson },
}

export type TypeEnrichedEIP712MessageRecord = EnrichedGroupedSolidityType
	| { type: 'record', value: { [x: string]: TypeEnrichedEIP712MessageRecord | undefined } }
	| { type: 'record[]', value: ReadonlyArray<{ [x: string]: TypeEnrichedEIP712MessageRecord | undefined }> }
	| { type: 'nestedArray', value: readonly TypeEnrichedEIP712MessageRecord[] }
export type EnrichedEIP712MessageRecord = funtypes.Static<typeof EnrichedEIP712MessageRecord>
export const EnrichedEIP712MessageRecord: funtypes.Runtype<TypeEnrichedEIP712MessageRecord> = funtypes.Lazy(() => funtypes.Union(
	EnrichedGroupedSolidityType,
	funtypes.ReadonlyObject({ type: funtypes.Literal('record'), value: funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('record[]'), value: funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord)) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('nestedArray'), value: funtypes.ReadonlyArray(EnrichedEIP712MessageRecord) }),
))

export type EnrichedEIP712Message = funtypes.Static<typeof EnrichedEIP712Message>
export const EnrichedEIP712Message = funtypes.ReadonlyRecord(
	funtypes.String,
	EnrichedEIP712MessageRecord,
)

export type EnrichedEIP712 = funtypes.Static<typeof EnrichedEIP712>
export const EnrichedEIP712 = funtypes.ReadonlyObject({
	primaryType: funtypes.String,
	message: EnrichedEIP712Message,
	domain: EnrichedEIP712Message,
})

const numberAsBigIntParser: funtypes.ParsedValue<funtypes.Number, bigint>['config'] = {
	parse: value => {
		if (!Number.isInteger(value)) return { success: false, message: `${value} is not integer.` }
		if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) return { success: false, message: `${value} is out of bounds` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (!Number.isInteger(value)) return { success: false, message: `${value} is not integer.` }
		if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) return { success: false, message: `${value} is out of bounds` }
		return { success: true, value: Number(value) }
	},
}

const NumberAsBigInt = funtypes.Number.withParser(numberAsBigIntParser)
export type NumberAsBigInt = funtypes.Static<typeof NumberAsBigInt>

export type Eip712Number = funtypes.Static<typeof Eip712Number>
export const Eip712Number = funtypes.Union(EthereumQuantity, NonHexBigInt, NumberAsBigInt)
