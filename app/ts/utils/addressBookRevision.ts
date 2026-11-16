import { Semaphore } from './semaphore.js'

// Track committed metadata writes at the storage boundary, including atomic settings imports.
let addressBookRevision = 0
const addressBookRevisionSemaphore = new Semaphore(1)
export const getAddressBookRevision = () => addressBookRevision
export const getSettledAddressBookRevision = async () => await addressBookRevisionSemaphore.execute(async () => addressBookRevision)

export async function storeAddressBookRevision(write: () => Promise<void>) {
	await addressBookRevisionSemaphore.execute(async () => {
		await write()
		addressBookRevision += 1
	})
}
