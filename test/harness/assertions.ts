// Helpers for reading untyped test data (recorded messages, JSON replies, stored items) without casts.
//
// Usage:
//   const reply = requireDefined(replies.at(-1), 'the last reply')             // throws "Missing the last reply" instead of continuing with undefined
//   if (!isRecord(parsedJson)) throw new Error('Expected a JSON object')
//   assert.equal(readProperty(readProperty(message, 'data'), 'isOpen'), true)  // undefined when a level is not an object or lacks the property
//   if (isObjectWithOptionalProperties<'method' | 'data'>(message)) use(message.data)  // typed optional access to the listed properties

export function requireDefined<T>(value: T | undefined, description: string): T {
	if (value === undefined) throw new Error(`Missing ${ description }`)
	return value
}

// The app's guard for plain objects such as parsed JSON objects; arrays are rejected.
export { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'

export function readProperty(value: unknown, property: PropertyKey): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, property)
}

// Every object can be read through this shape because all listed properties are optional unknown values, so isObjectWithOptionalProperties only rejects non-objects and does not check that the properties are present.
export type PropertiesOf<Keys extends string> = { readonly [Key in Keys]?: unknown }

export function isObjectWithOptionalProperties<Keys extends string>(value: unknown): value is PropertiesOf<Keys> {
	return typeof value === 'object' && value !== null
}
