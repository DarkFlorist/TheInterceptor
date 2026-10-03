export const MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH = 42

export function isValidAddressBookEntryName(name: string) {
	return name.length > 0 && name.length <= MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH
}
