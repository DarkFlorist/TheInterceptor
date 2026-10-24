// How FetchSimulationStack combines its two opening replies with publications. The page requests the stack and its address references once when it opens and then follows publications, so its replies and the publications can arrive in either order; the state semantics this relies on live in utils/popupVisualisationLifecycle.ts.
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { CompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import { hasCurrentAddressBookEntries, predatesVisualisation } from '../../utils/popupVisualisationLifecycle.js'
import { assertNever } from '../../utils/typescript.js'

// What the page shows: the stack's rows and its address references, undefined until the opening metadata reply or a finished publication supplies them.
export type ShownSimulationStack = {
	readonly visualisation: CompleteVisualizedSimulation
	readonly addressBookEntries: readonly AddressBookEntry[] | undefined
}

export type SimulationStackUpdate =
	| { readonly source: 'publication', readonly visualisation: CompleteVisualizedSimulation }
	| { readonly source: 'openingVisualisationReply', readonly visualisation: CompleteVisualizedSimulation }
	| { readonly source: 'openingMetadataReply', readonly addressBookEntries: readonly AddressBookEntry[] }

// The one place that decides what an update may replace. The opening replies travel separately from publications, so either can arrive first; a reply must not replace newer published data, while every publication is shown.
export function applySimulationStackUpdate(shown: ShownSimulationStack, update: SimulationStackUpdate): ShownSimulationStack {
	switch (update.source) {
		// While a refresh runs or after it fails, the address references of the last finished refresh stay.
		case 'publication': return {
			visualisation: update.visualisation,
			addressBookEntries: hasCurrentAddressBookEntries(update.visualisation) ? update.visualisation.addressBookEntries : shown.addressBookEntries,
		}
		case 'openingVisualisationReply': {
			if (predatesVisualisation(update.visualisation, shown.visualisation)) return shown
			return { ...shown, visualisation: update.visualisation }
		}
		// Only a finished publication supplies references before this reply, and later finished publications keep them current, so the reply only fills references nothing has supplied yet.
		case 'openingMetadataReply': {
			if (shown.addressBookEntries !== undefined) return shown
			return { ...shown, addressBookEntries: update.addressBookEntries }
		}
		default: return assertNever(update)
	}
}
