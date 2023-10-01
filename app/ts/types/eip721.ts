import * as funtypes from 'funtypes'
import { JSONEncodeableObject, isJSON } from '../utils/json.js'
import { EthereumData, EthereumQuantity, serialize } from './wire-types.js'
import { AddressBookEntry } from './addressBookTypes.js'

export type EIP712MessageUnderlying = funtypes.Static<typeof EIP712MessageUnderlying>
export const EIP712MessageUnderlying = funtypes.ReadonlyObject({
	types: funtypes.Record(funtypes.String, funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			name: funtypes.String,
			type: funtypes.String,
		})
	)),
	primaryType: funtypes.String,
	domain: JSONEncodeableObject,
	message: JSONEncodeableObject,
})

const EIP712MessageParser: funtypes.ParsedValue<funtypes.String, EIP712MessageUnderlying>['config'] = {
	parse: value => {
		if (!isJSON(value) || !EIP712MessageUnderlying.test(JSON.parse(value))) return { success: false, message: `${ value } is not EIP712 message` }
		else return { success: true, value: EIP712MessageUnderlying.parse(JSON.parse(value)) }
	},
	serialize: value => {
		if (!EIP712MessageUnderlying.test(value)) return { success: false, message: `${ value } is not a EIP712 message.`}
		return { success: true, value: JSON.stringify(serialize(EIP712MessageUnderlying, value)) }
	},
}

export type EIP712Message = funtypes.Static<typeof EIP712Message>
export const EIP712Message = funtypes.String.withParser(EIP712MessageParser)

export type GroupedSolidityType = funtypes.Static<typeof GroupedSolidityType>
export const GroupedSolidityType = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('integer'), value: EthereumQuantity }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bytes'), value: EthereumData }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('fixedBytes'), value: EthereumData }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bool'), value: funtypes.Boolean }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('string'), value: funtypes.String }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('address'), value: AddressBookEntry }),
	
	funtypes.ReadonlyObject({ type: funtypes.Literal('integer[]'), value: funtypes.ReadonlyArray(EthereumQuantity) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bytes[]'), value: funtypes.ReadonlyArray(EthereumData) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('fixedBytes[]'), value: funtypes.ReadonlyArray(EthereumData) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('bool[]'), value: funtypes.ReadonlyArray(funtypes.Boolean) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('string[]'), value: funtypes.ReadonlyArray(funtypes.String) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('address[]'), value: funtypes.ReadonlyArray(AddressBookEntry) }),
)

type typeEnrichedEIP712MessageRecord = GroupedSolidityType | { type: 'record', value: { [x: string]: typeEnrichedEIP712MessageRecord | undefined } } | { type: 'record[]', value: ReadonlyArray<{ [x: string]: typeEnrichedEIP712MessageRecord | undefined }> }
export type EnrichedEIP712MessageRecord = funtypes.Static<typeof EnrichedEIP712MessageRecord>
export const EnrichedEIP712MessageRecord: funtypes.Runtype<typeEnrichedEIP712MessageRecord> = funtypes.Lazy(() => funtypes.Union(
	GroupedSolidityType,
	funtypes.ReadonlyObject({ type: funtypes.Literal('record'), value: funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('record[]'), value: funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, EnrichedEIP712MessageRecord)) }),
))

export type EnrichedEIP712Message = funtypes.Static<typeof EnrichedEIP712Message>
export const EnrichedEIP712Message = funtypes.ReadonlyRecord(
	funtypes.String,
	EnrichedEIP712MessageRecord,
)

export type EnrichedEIP712 = funtypes.Static<typeof EnrichedEIP712>
export const EnrichedEIP712 = funtypes.ReadonlyObject({
	message: EnrichedEIP712Message,
	domain: EnrichedEIP712Message,
})