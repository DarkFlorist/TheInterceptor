import * as funtypes from 'funtypes'

export type typeJSONEncodeable = string | number | boolean | null | { [x: string]: typeJSONEncodeable | undefined } | readonly typeJSONEncodeable[]
export type JSONEncodeable = funtypes.Static<typeof JSONEncodeable>
const JSONEncodeableNumber = funtypes.Number.withConstraint(Number.isFinite)
export const JSONEncodeable: funtypes.Runtype<typeJSONEncodeable> = funtypes.Lazy(() => funtypes.Union(
	funtypes.String,
	funtypes.Boolean,
	JSONEncodeableNumber,
	funtypes.Null,
	funtypes.ReadonlyArray(JSONEncodeable),
	funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable),
))

export function isJSONEncodeable(value: unknown, ancestors = new WeakSet<object>()): value is typeJSONEncodeable {
	if (value === null) return true
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return true
		case 'number':
			return Number.isFinite(value)
		case 'object':
			break
		default:
			return false
	}

	if (ancestors.has(value)) return false
	ancestors.add(value)
	try {
		return Array.isArray(value)
			? isJSONEncodeableArray(value, ancestors)
			: isJSONEncodeablePlainObject(value, ancestors)
	} finally {
		ancestors.delete(value)
	}
}

function isJSONEncodeableArray(value: readonly unknown[], ancestors: WeakSet<object>) {
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length') continue
		if (typeof key === 'symbol') return false
		const index = Number(key)
		if (!Number.isInteger(index) || index < 0 || index >= value.length || `${ index }` !== key || !Object.prototype.propertyIsEnumerable.call(value, key)) return false
	}
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) return false
		if (!isJSONEncodeable(Object.getOwnPropertyDescriptor(value, `${ index }`)?.value, ancestors)) return false
	}
	return true
}

function isJSONEncodeablePlainObject(value: object, ancestors: WeakSet<object>) {
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return false

	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return false
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false
		if (!isJSONEncodeable(Object.getOwnPropertyDescriptor(value, key)?.value, ancestors)) return false
	}

	return true
}

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
	return JSON.parse(jsonString, reviver as (this: unknown, key: string, value: unknown) => unknown)
}
