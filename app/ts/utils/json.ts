import * as funtypes from 'funtypes'

type typeJSONEncodeable = string | number | boolean | { [x: string]: typeJSONEncodeable | undefined } | ReadonlyArray<typeJSONEncodeable>
export type JSONEncodeable = funtypes.Static<typeof JSONEncodeable>
export const JSONEncodeable: funtypes.Runtype<typeJSONEncodeable> = funtypes.Lazy(() => funtypes.Union(
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

export type JSONEncodeableObjectOrArray = funtypes.Static<typeof JSONEncodeableObjectOrArray>
export const JSONEncodeableObjectOrArray = funtypes.Union(JSONEncodeableObject, JSONEncodeableObjectArray)

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
