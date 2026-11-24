// Helpers for replacing and restoring shared global state in bun tests.
//
// `bun run test` passes --isolate, so every test file starts with a fresh global object. Inside a file, tests still share globals: use replaceGlobal or replaceProperty and call the returned restore function (for example in afterEach, or through createPerTestRestorer from perTest.ts).
//
// Usage:
//   const restoreFetch = replaceGlobal('fetch', async () => new Response('{}'))
//   afterEach(restoreFetch)
//   const restoreWarn = replaceProperty(console, 'warn', () => undefined)

const describeKey = (key: PropertyKey) => typeof key === 'symbol' ? key.toString() : String(key)

// Replaces one own property with a configurable, writable data property and returns a function that puts the previous property back. When the key is a property the target's type declares, the value is typed as that property, so a replacement callback gets its parameter types; other keys, such as globals the types do not declare, take any value.
export function replaceProperty<Target extends object, Key extends keyof Target>(target: Target, key: Key, value: Target[Key]): () => void
export function replaceProperty(target: object, key: PropertyKey, value: unknown): () => void
export function replaceProperty(target: object, key: PropertyKey, value: unknown): () => void {
	const previousDescriptor = Reflect.getOwnPropertyDescriptor(target, key)
	if (!Reflect.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: previousDescriptor?.enumerable ?? true })) {
		throw new Error(`Could not replace non-configurable property ${ describeKey(key) }`)
	}
	return () => {
		const restored = previousDescriptor === undefined
			? Reflect.deleteProperty(target, key)
			: Reflect.defineProperty(target, key, previousDescriptor)
		if (!restored) throw new Error(`Could not restore property ${ describeKey(key) }`)
	}
}

export const replaceGlobal = (key: PropertyKey, value: unknown) => replaceProperty(globalThis, key, value)
