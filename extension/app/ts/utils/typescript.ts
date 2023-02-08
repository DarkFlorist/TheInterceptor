export type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> }

export type PartiallyRequired<T, TKeys extends keyof T> = { [P in keyof T]: T[P] } & { [P in TKeys]-?: T[P] }

export type GetAllKeys<T> = T extends unknown ? keyof T : never
export type GetAllValues<T, K extends string | number | symbol> = T extends object ? K extends keyof T ? T[K] : never : never
export type Merge<T> = { [K in GetAllKeys<T>]: GetAllValues<T, K> }

export type UnionToIntersection<T> = (T extends unknown ? (k: T) => void : never) extends (k: infer I) => void ? I : never

export type AbstractConstructorParameters<T extends abstract new (...args: any[]) => any> = T extends abstract new (...args: infer U) => any ? U : never

export type ToKeyedObject<T, U extends keyof T> = { [Key in T[U] & PropertyKey]: Extract<T, { [_ in U]: Key}> }

export type TupleOf<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never
type _TupleOf<T, N extends number, R extends unknown[]> = R['length'] extends N ? R : _TupleOf<T, N, [T, ...R]>

export function isKeyOf<T extends {}, K extends string | number | symbol>(set: T, key: K): key is keyof T & K {
	return key in set
}

export function assert(condition: boolean, message: string): asserts condition is true {
	if (condition) return
	throw new Error(message)
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`)
}

export function assertsOneOf<T, U extends T>(item: T, array: readonly U[], message: string): asserts item is U {
	if (array.includes(item as U)) return
	throw new Error(message)
}

export type DistributedPick<T, K extends string> = T extends unknown ? { [P in K & keyof T]: T[P] } : never
export type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type DistributiveOmit<T extends object, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export function isObject(maybe: unknown): maybe is Object {
	return typeof maybe === 'object' && maybe !== null && !Array.isArray(maybe)
}
export function assertIsObject(maybe: unknown): asserts maybe is Object {
	if (!isObject(maybe)) throw new Error(`Expected object but got ${ typeof maybe }`)
}
