import { useEffect } from 'preact/hooks'
import { Home } from './pages/Home.js'
import Hint from './subcomponents/Hint.js'
import { getAddress, isAddress } from '../utils/ethereumPrimitives.js'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import type { Settings } from '../types/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import type { EthereumBytes32 } from '../types/wire-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcEntry } from '../types/rpc.js'
import { UnexpectedError } from './subcomponents/Error.js'
import { addressEditEntry } from './ui-utils.js'
import { Signal, useComputed, useSignal } from '@preact/signals'
import { POPUP_PERFORMANCE_MARKS, markPerformanceOnce } from '../utils/popupPerformance.js'
import { createUnexpectedErrorPopupMessage } from '../utils/unexpectedErrorPopupMessage.js'
import { useLiveSimulationHomeData } from './hooks/useLiveSimulationHomeData.js'
import { NetworkErrors } from './subcomponents/NetworkErrors.js'
import { ProviderErrors } from './subcomponents/ProviderErrors.js'
import { PopupModal, type PopupPage } from './PopupModal.js'
import { getOptimisticActiveAddressSelection, getSelectableActiveAddresses, includePersistedAddressBookEntry, isActiveAddressSelectionAllowed, isSignerConnectedForMode } from '../utils/activeAddressSelection.js'
import { requestActiveAddressChange } from './activeAddressChange.js'
import { DinoSaysNotification } from './subcomponents/DinoSays.js'
import { useModeActiveAddress } from './hooks/useModeActiveAddress.js'
export { NetworkErrors } from './subcomponents/NetworkErrors.js'

export function App() {
	const appPage = useSignal<PopupPage>({ page: 'Unknown' })
	const showActiveAddressSelectionResetNotice = useSignal(false)
	const {
		activeAddresses,
		walletSelectedAddressBookEntry,
		activeSimulationAddress,
		activeSigningSafeAddress,
		displayedSigningAddress,
		useSignersAddressAsActiveAddress,
		simVisResults,
		websiteAccess,
		websiteAccessAddressMetadata,
		rpcNetwork,
		tabIconDetails,
		isSettingsLoaded,
		isFreshHomeDataLoaded,
		currentBlockNumber,
		tabState,
		rpcConnectionStatus,
		rpcEntries,
		simulationUpdatingState,
		simulationResultState,
		interceptorDisabled,
		unexpectedError,
		preSimulationBlockTimeManipulation,
		popupRefreshAppliedGeneration,
		fixedAddressRichList,
		makeCurrentAddressRich,
		simulationMode,
		numberOfAddressesMadeRich,
		hasSafeTransactionsToExport,
	} = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: true,
		requestHomeDataOnSimulationStateChange: true,
		onActiveAddressSelectionResetNotice() {
			showActiveAddressSelectionResetNotice.value = true
		},
		onInitialSettings(settings: Settings) {
			if (appPage.value.page !== 'Unknown') return
			if (settings.openedPage.page === 'AddNewAddress' || settings.openedPage.page === 'ModifyAddress') {
				appPage.value = { ...settings.openedPage, state: new Signal(settings.openedPage.state) }
				return
			}
			appPage.value = settings.openedPage
		},
	})
	const boundaryResetKey = useSignal(0)
	async function dismissActiveAddressSelectionResetNotice() {
		if (!showActiveAddressSelectionResetNotice.value) return
		showActiveAddressSelectionResetNotice.value = false
		await sendPopupMessageToBackgroundPage({ method: 'popup_acknowledgeActiveAddressSelectionResetNotice' })
	}

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer', persistedEntry?: AddressBookEntry) {
		if (!isSettingsLoaded.value) return
		const selectableAddresses = includePersistedAddressBookEntry(activeAddresses.value, persistedEntry)
		if (!isActiveAddressSelectionAllowed(address, selectableAddresses, simulationMode.value, rpcNetwork.value?.chainId, tabState.value?.signerAccounts ?? [])) return
		await requestActiveAddressChange(address, simulationMode.value)
		const optimisticSelection = getOptimisticActiveAddressSelection(address, simulationMode.value, tabState.value?.signerAccounts ?? [])
		if (optimisticSelection.mode === 'simulation') {
			activeSimulationAddress.value = optimisticSelection.activeSimulationAddress
			useSignersAddressAsActiveAddress.value = optimisticSelection.useSignersAddressAsActiveAddress
			showActiveAddressSelectionResetNotice.value = false
			return
		}
		displayedSigningAddress.value = optimisticSelection.displayedSigningAddress
		activeSigningSafeAddress.value = address === 'signer' ? undefined : optimisticSelection.displayedSigningAddress
	}

	function isSignerConnected() {
		return isSignerConnectedForMode(simulationMode.value, activeSimulationAddress.value, tabState.value)
	}

	async function setActiveRpcAndInformAboutIt(entry: RpcEntry) {
		if (!isSettingsLoaded.value) return
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: entry })
		if(!isSignerConnected()) {
			rpcNetwork.value = entry
		}
	}
	useEffect(() => {
		markPerformanceOnce(POPUP_PERFORMANCE_MARKS.homeFirstCommit)
	}, [])

	useEffect(() => {
		if (popupRefreshAppliedGeneration.value === 0) return
		markPerformanceOnce(POPUP_PERFORMANCE_MARKS.refreshRendered)
	}, [popupRefreshAppliedGeneration.value])

	function goHome() {
		const newPage = { page: 'Home' } as const
		appPage.value = newPage
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	function changeActiveAddress() {
		const newPage = { page: 'ChangeActiveAddress' } as const
		appPage.value = newPage
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	async function addressPaste(address: string) {
		if (!isSettingsLoaded.value) return
		if (appPage.value !== undefined && appPage.value.page === 'AddNewAddress') return

		const trimmed = address.trim()
		if (!isAddress(trimmed)) return

		const bigIntReprentation = BigInt(trimmed)
		// see if we have that address, if so, let's switch to it
		for (const activeAddress of activeAddresses.value) {
			if (activeAddress.address === bigIntReprentation) return await setActiveAddressAndInformAboutIt(activeAddress.address)
		}

		// address not found, let's promt user to create it
		const addressString = getAddress(trimmed)
		const newPage = { page: 'AddNewAddress', state: {
			windowStateId: 'appAddressPaste',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				type: 'contact',
				name: `Pasted ${ truncateAddr(addressString) }`,
				address: checksummedAddress(bigIntReprentation),
				askForAddressAccess: true,
				entrySource: 'FilledIn',
				abi: undefined,
				useAsActiveAddress: true,
				declarativeNetRequestBlockMode: undefined,
				chainId: rpcConnectionStatus.peek()?.rpcNetwork.chainId ?? 1n,
			}
		} } as const
		appPage.value = { page: 'AddNewAddress', state: new Signal(newPage.state) }
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		const newPage = { page: 'ModifyAddress', state: addressEditEntry(entry) } as const
		appPage.value = { page: 'ModifyAddress', state: new Signal(newPage.state) }
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	function addNewAddress() {
		const newPage = { page: 'AddNewAddress', state: {
			windowStateId: 'appNewAddress',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				type: 'contact',
				name: undefined,
				address: undefined,
				askForAddressAccess: true,
				entrySource: 'FilledIn',
				abi: undefined,
				useAsActiveAddress: true,
				declarativeNetRequestBlockMode: undefined,
				chainId: rpcConnectionStatus.peek()?.rpcNetwork.chainId ?? 1n,
			} }
		} as const
		appPage.value = { page: 'AddNewAddress', state: new Signal(newPage.state) }
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	function editEnsNamedHashCallBack(type: 'nameHash' | 'labelHash', nameHash: EthereumBytes32, name: string | undefined) {
		const newPage = { page: 'EditEnsNamedHash', state: { type, nameHash, name } } as const
		appPage.value = newPage
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: newPage })
	}

	async function openWebsiteAccess() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_openWebsiteAccess' })
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	async function openAddressBook() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' })
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	async function openSettings() {
		await sendPopupMessageToBackgroundPage({ method: 'popup_openSettings' })
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	function onRenderError(error: Error) {
		unexpectedError.value = createUnexpectedErrorPopupMessage({
			timestamp: new Date(),
			message: error.message,
			source: 'popup',
			code: 'render_error',
			debugId: undefined,
		})
	}
	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		boundaryResetKey.value += 1
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}

	const modeActiveAddress = useModeActiveAddress({ activeAddresses, simulationMode, activeSimulationAddress, activeSigningSafeAddress, displayedSigningAddress, rpcNetwork, tabState })
	const selectableActiveAddresses = useComputed(() =>
		getSelectableActiveAddresses(activeAddresses.value, simulationMode.value, rpcNetwork.value?.chainId, tabState.value?.signerAccounts ?? [])
	)

	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { isSettingsLoaded.value && (appPage.value.page === 'Unknown' || appPage.value.page === 'Home') } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage.value.page !== 'Unknown' && appPage.value.page !== 'Home' ? 'overflow: hidden;' : 'overflow-y: auto; overflow-x: hidden' }` }>
					<nav class = 'navbar window-header' role = 'navigation' aria-label = 'main navigation'>
						<div class = 'navbar-brand'>
							<a class = 'navbar-item' style = 'cursor: unset'>
								<img src = '../img/LOGOA.svg' alt = 'Logo' width = '32' height = '32'/>
								<p style = 'color: var(--text-color); padding-left: 5px;'>THE INTERCEPTOR
									<span style = 'color: var(--unimportant-text-color); font-size: 0.8em; padding-left: 5px;' > { `${ version } - ${ gitCommitSha.slice(0, 8) }`  } </span>
								</p>
							</a>
							<a class = 'navbar-item' style = 'margin-left: auto; margin-right: 0;'>
								<img src = '../img/internet.svg' width = '32' height = '32' onClick = { openWebsiteAccess }/>
								<img src = '../img/address-book.svg' width = '32' height = '32' onClick = { openAddressBook }/>
								<img src = '../img/settings.svg' width = '32' height = '32' onClick = { openSettings }/>
							</a>
						</div>
					</nav>

				<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value === undefined ? undefined : unexpectedError.value.data }/>
					{ showActiveAddressSelectionResetNotice.value
						? <DinoSaysNotification
							text = 'Simulation and signing addresses are now kept separately. Your previous shared selection was reset; choose the addresses you want to use in each mode.'
							close = { dismissActiveAddressSelectionResetNotice }
						/>
						: <></> }
					<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
					<ProviderErrors tabState = { tabState }/>
					<Home
						setActiveRpcAndInformAboutIt = { setActiveRpcAndInformAboutIt }
						rpcNetwork = { rpcNetwork }
						simVisResults = { simVisResults }
						useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
						displayedSigningAddress = { displayedSigningAddress }
						activeSigningSafeAddress = { activeSigningSafeAddress }
						activeSimulationAddress = { activeSimulationAddress }
						changeActiveAddress = { changeActiveAddress }
						makeCurrentAddressRich = { makeCurrentAddressRich }
						activeAddresses = { activeAddresses }
						walletSelectedAddressBookEntry = { walletSelectedAddressBookEntry }
						simulationMode = { simulationMode }
						tabIconDetails = { tabIconDetails }
						currentBlockNumber = { currentBlockNumber }
						tabState = { tabState }
						renameAddressCallBack = { renameAddressCallBack }
						editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
						rpcConnectionStatus = { rpcConnectionStatus }
						rpcEntries = { rpcEntries }
						simulationUpdatingState = { simulationUpdatingState }
						simulationResultState = { simulationResultState }
						interceptorDisabled = { interceptorDisabled }
						preSimulationBlockTimeManipulation = { preSimulationBlockTimeManipulation }
						fixedAddressRichList = { fixedAddressRichList }
						numberOfAddressesMadeRich = { numberOfAddressesMadeRich }
						hasSafeTransactionsToExport = { hasSafeTransactionsToExport }
						isInitialHomeDataLoaded = { isSettingsLoaded }
						isFreshHomeDataLoaded = { isFreshHomeDataLoaded }
					/>

						<PopupModal
							page = { appPage }
							boundaryResetKey = { boundaryResetKey }
							onRenderError = { onRenderError }
							goHome = { goHome }
							websiteAccess = { websiteAccess }
							websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
							renameAddressCallBack = { renameAddressCallBack }
							setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
							allowCreateAndSwitch = { simulationMode.value }
							signerAccounts = { tabState.value?.signerAccounts ?? [] }
							activeAddresses = { selectableActiveAddresses }
							signerName = { tabState.value?.signerName ?? 'NoSignerDetected' }
							addNewAddress = { addNewAddress }
							activeAddress = { modeActiveAddress.value.activeAddress }
							rpcEntries = { rpcEntries }
						/>
				</div>
			</Hint>
		</main>
	)
}
