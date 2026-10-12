import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import type { SimulationState } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedEthereumEvents } from '../../types/EnrichedEthereumData.js'
import { getFundsDestinations, type IdentifyAddress } from '../fundsDestinations.js'
import { findLookalikeDestinations, type KnownAddressIndexesLoader } from '../lookalikeAddresses.js'

const getNotInAddressBookWarning = (destinations: readonly AddressBookEntry[]) => {
	const unknownDestinations = destinations.filter((destination) => destination.entrySource === 'OnChain')
	if (unknownDestinations.length === 0) return undefined
	if (unknownDestinations.length === 1) {
		const unknownDestination = unknownDestinations[0]
		if (unknownDestination === undefined) throw new Error('unknown destination was missing')
		return `This transaction sends funds to "${ unknownDestination.name }", which is not in the addressbook. Please add the address to addressbook to dismiss this error in the future.`
	}
	const destinationNames = unknownDestinations.map((destination) => `"${ destination.name }"`).join(', ')
	return `This transaction sends funds to ${ destinationNames }, which are not in the addressbook. Please add the addresses to addressbook to dismiss this error in the future.`
}

export async function getSendToNonContactWarning(transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents, identify: IdentifyAddress, loadKnownAddressIndexes: KnownAddressIndexesLoader) {
	const destinations = await getFundsDestinations(transaction, events, identify)
	// Lookalike destinations are skipped because the sendToLookalikeAddress protector (registered next to this one in protectorRunner.ts) warns about them, and advising to add a poisoning address to the address book would help the scam.
	const lookalikeAddresses = new Set((await findLookalikeDestinations(destinations, loadKnownAddressIndexes)).map(({ destination }) => destination.address))
	return getNotInAddressBookWarning(destinations.filter((destination) => !lookalikeAddresses.has(destination.address)))
}

export async function sendToNonContact(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState, eventsPromise: Promise<EnrichedEthereumEvents>, loadKnownAddressIndexes: KnownAddressIndexesLoader) {
	const events = await eventsPromise
	return await getSendToNonContactWarning(transaction, events, async (address) => await identifyAddress(ethereum, requestAbortController, address), loadKnownAddressIndexes)
}
