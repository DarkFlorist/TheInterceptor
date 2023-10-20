export function areEqual(first?: Uint8Array, second?: Uint8Array) {
	if (first === second) return true
	if (first === undefined) return second === undefined
	if (second === undefined) return first === undefined
	if (first.length !== second.length) return false
	return first.every((value, index) => value === second[index])
}

export function stripLeadingZeros(byteArray: Uint8Array): Uint8Array {
	let i = 0
	for (; i < byteArray.length; ++i) {
		if (byteArray[i] !== 0) break
	}
	const result = new Uint8Array(byteArray.length - i)
	for (let j = 0; j < result.length; ++j) {
		const byte = byteArray[i + j]
		if (byte === undefined) throw new Error('byte array is too short')
		result[j] = byte
	}
	return result
}

export function arrayToChunks<Type>(array: readonly Type[], chunkSize: number) {
	return Array.from(
		{ length: Math.ceil(array.length / chunkSize) }, (_, i) => array.slice(i * chunkSize, i * chunkSize + chunkSize)
	)
}

const arePropValuesEqual = <T>(subject: T, target: T, propNames: (keyof T)[]): boolean => propNames.every(propName => subject[propName] === target[propName])

export const getUniqueItemsByProperties = <T>(items: T[], propNames: (keyof T)[]): T[] => items.filter((item, index, array) => index === array.findIndex(foundItem => arePropValuesEqual(foundItem, item, propNames)))

export function includesWithComparator<T>(array: readonly T[], searchElement: T, comparator: (a: T, b: T) => boolean): boolean {
	for (const element of array) {
		if (comparator(element, searchElement)) return true
	}
	return false
}
