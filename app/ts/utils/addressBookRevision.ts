import { Semaphore } from './semaphore.js'

// Tracks persisted address-book and ENS names in this background lifetime. The storage setter owns revision updates, including atomic settings imports, repairs and cached identifications.
let addressBookRevision = 0
const addressBookRevisionSemaphore = new Semaphore(1)

export const getAddressBookRevision = () => addressBookRevision
export const getSettledAddressBookRevision = async () => await addressBookRevisionSemaphore.execute(async () => addressBookRevision)

// A settled read cannot fall between the storage commit and its revision update. Failed writes do not advance the revision.
export async function withAddressBookRevisionUpdate(write: () => Promise<void>) {
	await addressBookRevisionSemaphore.execute(async () => {
		await write()
		addressBookRevision += 1
	})
}
