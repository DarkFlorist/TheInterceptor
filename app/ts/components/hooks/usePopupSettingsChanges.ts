import { useEffect } from 'preact/hooks'
import { useComputed, useSignal } from '@preact/signals'
import { MessageToPopup, type PopupSettingsChangeStatus } from '../../types/interceptor-messages.js'
import { acceptPopupSettingsChangeStatus, getPopupSettingsOperationLabel } from '../../types/popupSettingsProtocol.js'
import type { PopupSettingsRequestWithSharedReply } from '../../types/popupSettingsRequests.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { RpcEntry } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { includePersistedAddressBookEntry, isActiveAddressSelectionAllowed } from '../../utils/activeAddressSelection.js'
import { requestActiveAddressChange } from '../activeAddressChange.js'
import { requestPopupSettingsChange } from '../popupSettingsChange.js'
import type { useLiveSimulationHomeData } from './useLiveSimulationHomeData.js'

type SettingsChangeHomeData = Pick<ReturnType<typeof useLiveSimulationHomeData>, 'isSettingsLoaded' | 'activeAddresses' | 'simulationMode' | 'rpcNetwork' | 'tabState' | 'displayedSigningAddress'>

export function usePopupSettingsChanges({ isSettingsLoaded, activeAddresses, simulationMode, rpcNetwork, tabState, displayedSigningAddress }: SettingsChangeHomeData) {
	const pendingAddressChangeRequestId = useSignal<string | undefined>(undefined)
	const isActiveAddressChanging = useSignal(false)
	// Local state covers dispatch latency; shared status coordinates other and reopened popups.
	const pendingSettingsChange = useSignal(false)
	const backgroundSettingsChange = useSignal<PopupSettingsChangeStatus['data']>({ revision: 0, operation: undefined })
	const isActiveAddressChangePending = useComputed(() => pendingAddressChangeRequestId.value !== undefined)
	const sharedStatusLabel = useComputed(() => !pendingSettingsChange.value && !isActiveAddressChangePending.value && backgroundSettingsChange.value.operation !== undefined ? getPopupSettingsOperationLabel(backgroundSettingsChange.value.operation) : undefined)
	const isSettingsChangePending = useComputed(() => isActiveAddressChangePending.value || pendingSettingsChange.value || backgroundSettingsChange.value.operation !== undefined)

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer', persistedEntry?: AddressBookEntry) {
		if (!isSettingsLoaded.value) return
		if (isSettingsChangePending.value) throw new Error('A settings change is already in progress. Please wait for it to finish.')
		const selectableAddresses = includePersistedAddressBookEntry(activeAddresses.value, persistedEntry)
		if (!isActiveAddressSelectionAllowed(address, selectableAddresses, simulationMode.value, rpcNetwork.value?.chainId, tabState.value?.signerAccounts ?? [])) return
		const requestId = crypto.randomUUID()
		pendingAddressChangeRequestId.value = requestId
		isActiveAddressChanging.value = true
		try {
			await requestActiveAddressChange(address, simulationMode.value, undefined, requestId)
			// Recover a missed commit notification from current background state, never from the original selection.
			if (isActiveAddressChanging.value) {
				await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: true } })
			}
		} finally {
			pendingAddressChangeRequestId.value = undefined
			isActiveAddressChanging.value = false
		}
	}

	async function changePopupSettings(message: PopupSettingsRequestWithSharedReply) {
		if (!isSettingsLoaded.value) return
		if (isSettingsChangePending.value) throw new Error('A settings change is already in progress. Please wait for it to finish.')
		pendingSettingsChange.value = true
		try {
			await requestPopupSettingsChange(message)
		} finally {
			pendingSettingsChange.value = false
		}
	}

	async function setActiveRpcAndInformAboutIt(entry: RpcEntry) {
		await changePopupSettings({ method: 'popup_changeActiveRpc', data: entry })
	}
	async function setSimulationMode(enabled: boolean) {
		await changePopupSettings({ method: 'popup_enableSimulationMode', data: enabled })
	}
	async function setRichState(add: boolean, address: bigint | 'CurrentAddress') {
		await changePopupSettings({ method: 'popup_modifyMakeMeRich', data: { add, address } })
	}

	useEffect(() => {
		let latestSettingsGeneration = 0
		const listener = (message: unknown) => {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success || parsed.value.role === 'confirmTransaction') return
			const update = parsed.value
			if (update.method === 'popup_settingsChangeStatus') {
				backgroundSettingsChange.value = acceptPopupSettingsChangeStatus(backgroundSettingsChange.value, update.data)
			}
			if (update.method === 'popup_settingsUpdated' || update.method === 'popup_UpdateHomePage' || update.method === 'popup_homePageBootstrap') {
				if (update.popupRefreshGeneration < latestSettingsGeneration) return
				latestSettingsGeneration = update.popupRefreshGeneration
			}
			if (update.method !== 'popup_settingsUpdated' || update.committedAddressChange === undefined) return
			const { requestId, activeAddress } = update.committedAddressChange
			if (pendingAddressChangeRequestId.value !== requestId) return
			if (!update.data.simulationMode) displayedSigningAddress.value = activeAddress
			isActiveAddressChanging.value = false
		}
		browser.runtime.onMessage.addListener(listener)
		void sendPopupMessageToBackgroundPage({ method: 'popup_requestSettingsChangeStatus' })
		return () => browser.runtime.onMessage.removeListener(listener)
	}, [])

	return { isActiveAddressChanging, isActiveAddressChangePending, isSettingsChangePending, sharedStatusLabel, setActiveAddressAndInformAboutIt, setActiveRpcAndInformAboutIt, setSimulationMode, setRichState }
}
