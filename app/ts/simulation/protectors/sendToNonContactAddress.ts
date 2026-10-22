import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import type { SimulationState } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'
import { loadKnownAddressIndexesForChain } from '../../background/lookalikeKnownAddresses.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedEthereumEvents } from '../../types/EnrichedEthereumData.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { getFundsDestinations, type IdentifyAddress } from '../fundsDestinations.js'
import { findLookalikeDestinations, type KnownAddressIndexesLoader, type LookalikeDestination } from '../lookalikeAddresses.js'

const ADDRESS_POISONING_EXPLANATION = 'Scammers create addresses that share the first and last characters of addresses you use, hoping you copy the wrong one (address poisoning). Verify the full address before continuing.'

const describeLookalikeDestination = ({ destination, lookalikeOf }: LookalikeDestination) => `${ checksummedAddress(destination.address) }, which looks like the address book entry "${ lookalikeOf.name }" (${ checksummedAddress(lookalikeOf.address) })`

const getLookalikeAddressWarning = (lookalikeDestinations: readonly LookalikeDestination[]) => {
	if (lookalikeDestinations.length === 0) return undefined
	const differentAddressNote = lookalikeDestinations.length === 1 ? 'but is a different address' : 'but these are different addresses'
	return `This transaction sends funds to ${ lookalikeDestinations.map(describeLookalikeDestination).join('; and to ') } ${ differentAddressNote }. ${ ADDRESS_POISONING_EXPLANATION }`
}

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

// Both warnings are decided here from one list of destinations: lookalikes get only the address poisoning warning, because advising to add a poisoning address to the address book would help the scam, and every other destination is checked for the address book warning.
export async function getSendToNonContactWarnings(transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents, identify: IdentifyAddress, loadKnownAddressIndexes: KnownAddressIndexesLoader): Promise<readonly string[]> {
	const destinations = await getFundsDestinations(transaction, events, identify)
	const lookalikeDestinations = await findLookalikeDestinations(destinations, loadKnownAddressIndexes)
	const lookalikeAddresses = new Set(lookalikeDestinations.map(({ destination }) => destination.address))
	const nonLookalikeDestinations = destinations.filter((destination) => !lookalikeAddresses.has(destination.address))
	const warnings = [getLookalikeAddressWarning(lookalikeDestinations), getNotInAddressBookWarning(nonLookalikeDestinations)]
	return warnings.filter((warning) => warning !== undefined)
}

// Binds the background readers of the address book and bundled metadata, so getSendToNonContactWarnings decides only from its explicit inputs.
export async function sendToNonContact(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState, eventsPromise: Promise<EnrichedEthereumEvents>): Promise<readonly string[]> {
	const events = await eventsPromise
	return await getSendToNonContactWarnings(transaction, events, async (address) => await identifyAddress(ethereum, requestAbortController, address), async () => await loadKnownAddressIndexesForChain(ethereum.getChainId()))
}
