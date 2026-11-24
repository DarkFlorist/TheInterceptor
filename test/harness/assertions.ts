// Helpers for reading untyped test data (recorded messages, JSON replies, stored items) without casts.
//
// Usage:
//   const reply = requireDefined(replies.at(-1), 'the last reply')             // throws "Missing the last reply" instead of continuing with undefined
//   if (!isRecord(parsedJson)) throw new Error('Expected a JSON object')
//   assert.equal(readProperty(readProperty(message, 'data'), 'isOpen'), true)  // undefined when a level is not an object or lacks the property
//   if (canReadObjectProperties<'method' | 'data'>(message)) use(message.data)  // typed optional access to the listed properties

export function requireDefined<T>(value: T | undefined, description: string): T {
	if (value === undefined) throw new Error(`Missing ${ description }`)
	return value
}

// Test-owned JSON object guard: the generic harness has no application dependencies.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readProperty(value: unknown, property: PropertyKey): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, property)
}

// This grants only property-read capability: every listed value stays optional and unknown. Arrays are intentionally accepted; neither key presence nor value types are validated.
export type PropertiesOf<Keys extends string> = { readonly [Key in Keys]?: unknown }

export function canReadObjectProperties<Keys extends string>(value: unknown): value is PropertiesOf<Keys> {
	return typeof value === 'object' && value !== null
}
