export function areEqualUint8Arrays(first?: Uint8Array, second?: Uint8Array) {
	if (first === second) return true
	if (first === undefined) return second === undefined
	if (second === undefined) return first === undefined
	if (first.length !== second.length) return false
	return first.every((value, index) => value === second[index])
}

export function areEqualArrays<T>(first: T[], second: T[]) {
	if (first === second) return true
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

const arePropValuesEqual = <T>(subject: T, target: T, propNames: (keyof T)[]): boolean => propNames.every(propName => subject[propName] === target[propName])

export const getUniqueItemsByProperties = <T>(items: T[], propNames: (keyof T)[]): T[] => items.filter((item, index, array) => index === array.findIndex(foundItem => arePropValuesEqual(foundItem, item, propNames)))

export function replaceElementInReadonlyArray<T>(originalArray: readonly T[], index: number, newValue: T): readonly T[] {
	if (index < 0 || index >= originalArray.length) throw new Error('Index is out of bounds')
	const newArray = [...originalArray]
	newArray[index] = newValue
	return newArray
}

export function interleave<T>(arr: readonly T[], addBetween: T): T[] {
	return arr.reduce<T[]>((acc, curr, index) => {
		if (index !== arr.length - 1) acc.push(curr, addBetween)
		else acc.push(curr)
		return acc
	}, [])
}
