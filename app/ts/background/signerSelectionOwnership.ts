import type { TabState } from '../types/user-interface-types.js'

type StoredSignerSelection = Pick<TabState, 'selectedSignerProvider' | 'explicitlySelectedSignerProviderUuid' | 'selectedSignerConnectionName' | 'website'>

export function getExplicitSignerSelection(state: StoredSignerSelection) {
	const provider = state.selectedSignerProvider
	return provider !== undefined && state.explicitlySelectedSignerProviderUuid === provider.uuid && state.selectedSignerConnectionName !== undefined ? provider : undefined
}

export function getExplicitSignerSelectionForConnection(state: StoredSignerSelection, websiteOrigin: string, connectionName: bigint) {
	return state.website?.websiteOrigin === websiteOrigin && state.selectedSignerConnectionName === connectionName ? getExplicitSignerSelection(state) : undefined
}
