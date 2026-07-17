import type { EthereumAddress } from '../types/wire-types.js'

export function updateRichListAddress<Element>(
	currentList: readonly Element[],
	address: EthereumAddress,
	makeRich: boolean,
	getElementAddress: (element: Element) => EthereumAddress,
	createRichElement: () => Element,
): readonly Element[] {
	if (!makeRich) return currentList.filter((element) => getElementAddress(element) !== address)
	let foundAddress = false
	const updatedList = currentList.flatMap((element) => {
		if (getElementAddress(element) !== address) return [element]
		if (foundAddress) return []
		foundAddress = true
		return [createRichElement()]
	})
	if (foundAddress) return updatedList
	return [...updatedList, createRichElement()]
}
