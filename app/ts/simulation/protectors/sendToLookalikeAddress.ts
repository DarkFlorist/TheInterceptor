import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import type { SimulationState } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'
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

export async function getSendToLookalikeAddressWarning(transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents, identify: IdentifyAddress, loadKnownAddressIndexes: KnownAddressIndexesLoader) {
	const destinations = await getFundsDestinations(transaction, events, identify)
	return getLookalikeAddressWarning(await findLookalikeDestinations(destinations, loadKnownAddressIndexes))
}

export async function sendToLookalikeAddress(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState, eventsPromise: Promise<EnrichedEthereumEvents>, loadKnownAddressIndexes: KnownAddressIndexesLoader) {
	const events = await eventsPromise
	return await getSendToLookalikeAddressWarning(transaction, events, async (address) => await identifyAddress(ethereum, requestAbortController, address), loadKnownAddressIndexes)
}
