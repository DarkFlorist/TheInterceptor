import type { EthereumAddress, EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { IdentifyAddress } from '../types/metadataLookups.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'

// Chain reads needed by transaction protectors. A failed code lookup remains distinct from an address without code.
export type ProtectorChainReads = {
	readonly readCode: (address: EthereumAddress) => Promise<'present' | 'absent' | 'unverified'>
	readonly readGasPrice: () => Promise<bigint>
}

// Supplied by the caller so checks can run without a client, browser storage, or simulation state.
export type ProtectorContext = {
	readonly connectedChainId: bigint
	readonly chainReads: ProtectorChainReads
	readonly identify: IdentifyAddress
	readonly eventsPromise: Promise<EnrichedEthereumEvents>
}

export type Protector = (transaction: EthereumUnsignedTransaction, context: ProtectorContext) => Promise<string | undefined>
