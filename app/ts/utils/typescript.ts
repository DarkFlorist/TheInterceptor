export type UnionToIntersection<T> = (T extends unknown ? (k: T) => void : never) extends (k: infer I) => void ? I : never

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`)
}

export type DistributedOmit<T, K extends keyof UnionToIntersection<T>> = T extends unknown ? Pick<T, Exclude<keyof T, K>> : never

export type DistributiveOmit<T extends object, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export function assertUnreachable(value: never): never {
	throw new Error(`Unreachable! (${ value })`)
}

export function createGuard<T, U extends T>(check: (maybe: T) => U | undefined): (maybe: T) => maybe is U {
    return (maybe: T): maybe is U => check(maybe) !== undefined
}

export function getWithDefault<Key, Value>(map: Map<Key, Value>, key: Key, defaultValue: Value) {
	const previousValue = map.get(key)
	if (previousValue === undefined) return defaultValue
	return previousValue
}
