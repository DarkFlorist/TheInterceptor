import type { EthereumClientService } from './EthereumClientService.js'
import type { TokenPriceService } from './priceEstimator.js'

// The installed pair as this sublayer names it. serviceLifecycle's SimulationServices has the same shape, so the owner supplies its pair here without this leaf contract depending on the orchestration module.
export type InstalledServicesPair = {
	readonly ethereum: EthereumClientService
	readonly tokenPriceService: TokenPriceService
}

// What a client's owner answers about it. Whoever constructs a client must supply it, so a refresh can ask the client it was handed instead of holding the owner.
export type ClientLiveness = {
	// Whether the client is still the one its owner has installed, as opposed to replaced by a reset.
	readonly isCurrent: () => boolean
	// The pair the owner has installed now, so work holding a replaced client can hand its follow-up refresh to the live one; undefined when no owner installs the client.
	readonly installedServices: () => InstalledServicesPair | undefined
}

// For a client that no owner installs or replaces, such as a temporary lookup client: nothing can retire it.
export const alwaysLive: ClientLiveness = { isCurrent: () => true, installedServices: () => undefined }
