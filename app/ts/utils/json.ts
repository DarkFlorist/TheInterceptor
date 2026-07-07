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

export function getInvalidJSONEncodeableValuePath(value: unknown, path = '$', ancestors = new WeakSet<object>()): string | undefined {
	if (value === null) return undefined
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return undefined
		case 'number':
			return Number.isFinite(value) ? undefined : path
		case 'object':
			break
		default:
			return path
	}

	if (ancestors.has(value)) return path
	ancestors.add(value)

	if (Array.isArray(value)) {
		for (const key of Reflect.ownKeys(value)) {
			if (key === 'length') continue
			if (typeof key === 'symbol') {
				ancestors.delete(value)
				return `${ path }[${ String(key) }]`
			}
			const index = Number(key)
			if (!Number.isInteger(index) || index < 0 || index >= value.length || `${ index }` !== key || !Object.prototype.propertyIsEnumerable.call(value, key)) {
				ancestors.delete(value)
				return `${ path }.${ key }`
			}
		}
		for (let index = 0; index < value.length; index++) {
			if (!Object.prototype.hasOwnProperty.call(value, index)) {
				ancestors.delete(value)
				return `${ path }[${ index }]`
			}
			const nestedValue = Object.getOwnPropertyDescriptor(value, `${ index }`)?.value
			const nestedPath = getInvalidJSONEncodeableValuePath(nestedValue, `${ path }[${ index }]`, ancestors)
			if (nestedPath !== undefined) {
				ancestors.delete(value)
				return nestedPath
			}
		}
		ancestors.delete(value)
		return undefined
	}

	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		ancestors.delete(value)
		return path
	}

	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') {
			ancestors.delete(value)
			return `${ path }[${ String(key) }]`
		}
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
			ancestors.delete(value)
			return `${ path }.${ key }`
		}
		const nestedValue = Object.getOwnPropertyDescriptor(value, key)?.value
		const nestedPath = getInvalidJSONEncodeableValuePath(nestedValue, `${ path }.${ key }`, ancestors)
		if (nestedPath !== undefined) {
			ancestors.delete(value)
			return nestedPath
		}
	}

	ancestors.delete(value)
	return undefined
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
