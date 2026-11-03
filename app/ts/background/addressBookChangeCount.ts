// How many address-book changes have been published. addressBookChangePublication.ts counts each change before its re-label reads the stored runs, and a confirmation run compares the count from before its lookups with the count once it is stored (simulateAndStoreConfirmationRun in confirmationRunStorage.ts). It sits in its own module so the run storage depends only on the count, not on the publication and the re-labels it starts.
let publishedAddressBookChangeCount = 0

export const getPublishedAddressBookChangeCount = () => publishedAddressBookChangeCount

export const countPublishedAddressBookChange = () => {
	publishedAddressBookChangeCount += 1
}
