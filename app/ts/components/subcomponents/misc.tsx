export function insertBetweenElements<T>(array: readonly T[], elementToInsert: T): readonly T[] {
	if (array[0] === undefined) return []
	const newArray: T[] = [array[0]]
	for (let i = 1; i < array.length; ++i) {
		const entry = array[i]
		if (entry === undefined) throw new Error('array index overflow')
		newArray.push(elementToInsert, entry)
	}
	return newArray
}
