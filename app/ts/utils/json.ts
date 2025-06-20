import * as funtypes from 'funtypes'

export type typeJSONEncodeable = string | number | boolean | { [x: string]: typeJSONEncodeable | undefined } | readonly typeJSONEncodeable[]
type JSONEncodeable = funtypes.Static<typeof JSONEncodeable>
const JSONEncodeable: funtypes.Runtype<typeJSONEncodeable> = funtypes.Lazy(() => funtypes.Union(
	funtypes.String,
	funtypes.Boolean,
	funtypes.Number,
	funtypes.ReadonlyArray(JSONEncodeable),
	funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable),
))

export type JSONEncodeableObject = funtypes.Static<typeof JSONEncodeableObject>
export const JSONEncodeableObject = funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable)

export type JSONEncodeableObjectArray = funtypes.Static<typeof JSONEncodeableObjectOrArray>
export const JSONEncodeableObjectArray = funtypes.Union(funtypes.ReadonlyArray(JSONEncodeable))

type JSONEncodeableObjectOrArray = funtypes.Static<typeof JSONEncodeableObjectOrArray>
const JSONEncodeableObjectOrArray = funtypes.Union(JSONEncodeableObject, JSONEncodeableObjectArray)

export function isJSON(text: string){
	if (typeof text !== 'string') return false
	try {
		JSON.parse(text)
		return true
	}
	catch (error) {
		return false
	}
}

export function jsonParserWithNumbersAsStringsConverter(jsonString: string) {
	const reviver = (_key: string, value: unknown, context: { source: string }) => typeof value === 'number' && context !== undefined ? context.source : value
	// cast necessary until this is fixed: https://github.com/microsoft/TypeScript/issues/61330
	return JSON.parse(jsonString, reviver as (this: any, key: string, value: any) => any)
}
