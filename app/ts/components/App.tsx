import { useEffect } from 'preact/hooks'
import { defaultActiveAddresses } from '../background/settings.js'
import { SimulationAndVisualisationResults, SimulationState, TokenPriceEstimate, SimulationUpdatingState, SimulationResultState, NamedTokenId, ModifyAddressWindowState, EditEnsNamedHashWindowState, VisualizedSimulationState, BlockTimeManipulation, CompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { ChangeActiveAddress } from './pages/ChangeActiveAddress.js'
import { Home } from './pages/Home.js'
import { RpcConnectionStatus, TabIconDetails, TabState } from '../types/user-interface-types.js'
import Hint from './subcomponents/Hint.js'
import { AddNewAddress } from './pages/AddNewAddress.js'
import { InterceptorAccessList } from './pages/InterceptorAccessList.js'
import { ethers } from 'ethers'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import { DEFAULT_TAB_CONNECTION, METAMASK_ERROR_ALREADY_PENDING, METAMASK_ERROR_USER_REJECTED_REQUEST, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { UpdateHomePage, Settings, MessageToPopup } from '../types/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import { AddressBookEntry, AddressBookEntries } from '../types/addressBookTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../types/rpc.js'
import { ErrorBoundary, ErrorComponent, UnexpectedError } from './subcomponents/Error.js'
import { SignersLogoName } from './subcomponents/signers.js'
import { SomeTimeAgo } from './subcomponents/SomeTimeAgo.js'
import { noNewBlockForOverTwoMins } from '../background/iconHandler.js'
import { addressEditEntry, humanReadableDate } from './ui-utils.js'
import { EditEnsLabelHash } from './pages/EditEnsLabelHash.js'
import { Signal, useComputed, useSignal } from '@preact/signals'
import { EnrichedRichListElement, UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { PopupMessageReplyRequests } from '../types/interceptor-reply-messages.js'
import { ImportSimulationStack } from './pages/ImportSimulationStack.js'
import { CenterToPageTextSpinner } from './subcomponents/Spinner.js'

type ProviderErrorsParam = {
	tabState: Signal<TabState | undefined>
}

function ProviderErrors({ tabState } : ProviderErrorsParam) {
	if (tabState.value === undefined || tabState.value.signerAccountError === undefined) return <></>
	if (tabState.value.signerAccountError.code === METAMASK_ERROR_USER_REJECTED_REQUEST) return <ErrorComponent warning = { true } text = { <>Could not get an account from <SignersLogoName signerName = { tabState.value.signerName } /> as user denied the request.</> }/>
	if (tabState.value.signerAccountError.code === METAMASK_ERROR_ALREADY_PENDING.error.code) return <ErrorComponent warning = { true } text = { <>There's a connection request pending on <SignersLogoName signerName = { tabState.value.signerName } />. Please review the request.</> }/>
	return <ErrorComponent warning = { true } text = { <><SignersLogoName signerName = { tabState.value.signerName } /> returned error: "{ tabState.value.signerAccountError.message }".</> }/>
}

type NetworkErrorParams = {
	rpcConnectionStatus: Signal<RpcConnectionStatus>
}

export function NetworkErrors({ rpcConnectionStatus } : NetworkErrorParams) {
	if (rpcConnectionStatus.value === undefined) return <></>
	const nextConnectionAttempt = new Date(rpcConnectionStatus.value.lastConnnectionAttempt.getTime() + TIME_BETWEEN_BLOCKS * 1000)
	if (rpcConnectionStatus.value.retrying === false) return <></>
	return <>
		{ rpcConnectionStatus.value.isConnected === false ?
			<ErrorComponent warning = { true } text = {
				<>Unable to connect to { rpcConnectionStatus.value.rpcNetwork.name }. Retrying in <SomeTimeAgo priorTimestamp = { nextConnectionAttempt } countBackwards = { true }/> .</>
			}/>
		: <></> }
		{ rpcConnectionStatus.value.latestBlock !== undefined && noNewBlockForOverTwoMins(rpcConnectionStatus.value) && rpcConnectionStatus.value.latestBlock !== null ?
			<ErrorComponent warning = { true } text = {
				<>The connected RPC ({ rpcConnectionStatus.value.rpcNetwork.name }) seem to be stuck at block { rpcConnectionStatus.value.latestBlock.number } (occured on: { humanReadableDate(rpcConnectionStatus.value.latestBlock.timestamp) }). Retrying in <SomeTimeAgo priorTimestamp = { nextConnectionAttempt } countBackwards = { true }/>.</>
			}/>
		: <></> }
	</>
}

type Page = { page: 'Home' | 'ChangeActiveAddress' | 'AccessList' | 'Settings' | 'Unknown' }
	| { page: 'EditEnsNamedHash', state: EditEnsNamedHashWindowState }
	| { page: 'ModifyAddress' | 'AddNewAddress', state: Signal<ModifyAddressWindowState> }
	| { page: 'ChangeActiveAddress' }
	| { page: 'ImportSimulation', state: Signal<string> }

export function App() {
	const appPage = useSignal<Page>({ page: 'Unknown' })
	const activeAddresses = useSignal<AddressBookEntries>(defaultActiveAddresses)
	const activeSimulationAddress = useSignal<bigint | undefined>(undefined)
	const activeSigningAddress = useSignal<bigint | undefined>(undefined)
	const useSignersAddressAsActiveAddress = useSignal<boolean>(false)
	const simVisResults = useSignal<SimulationAndVisualisationResults | undefined>(undefined)
	const websiteAccess = useSignal<WebsiteAccessArray | undefined>(undefined)
	const websiteAccessAddressMetadata = useSignal<AddressBookEntries>([])
	const rpcNetwork = useSignal<RpcNetwork | undefined>(undefined)
	const tabIconDetails = useSignal<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const isSettingsLoaded = useSignal<boolean>(false)
	const currentBlockNumber = useSignal<bigint | undefined>(undefined)
	const tabState = useSignal<TabState | undefined>(undefined)
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const currentTabId = useSignal<number | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])
	const simulationUpdatingState = useSignal<SimulationUpdatingState | undefined>(undefined)
	const simulationResultState = useSignal<SimulationResultState | undefined>(undefined)
	const interceptorDisabled = useSignal<boolean>(false)
	const unexpectedError = useSignal<UnexpectedErrorOccured | undefined>(undefined)
	const boundaryResetKey = useSignal(0)
	const preSimulationBlockTimeManipulation = useSignal<BlockTimeManipulation | undefined>(undefined)

	const fixedAddressRichList = useSignal<readonly EnrichedRichListElement[]>([])
	const makeCurrentAddressRich = useSignal<boolean>(false)
	const simulationMode = useSignal<boolean>(false)

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		useSignersAddressAsActiveAddress.value = address === 'signer'
		if (address === 'signer') {
			sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: 'signer', simulationMode: simulationMode.value } })
			if (simulationMode.value) {
				activeSimulationAddress.value = tabState.value && tabState.value.signerAccounts.length > 0 ? tabState.value.signerAccounts[0] : undefined
				return
			}
			activeSigningAddress.value = tabState.value && tabState.value.signerAccounts.length > 0 ? tabState.value.signerAccounts[0] : undefined
			return
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: simulationMode.value } })
		if (simulationMode.value) {
			activeSimulationAddress.value = address
			return
		}
		activeSigningAddress.value = address
	}

	function isSignerConnected() {
		return tabState.value !== undefined && tabState.value.signerAccounts.length > 0
			&& (
				simulationMode.value && activeSimulationAddress.value !== undefined && tabState.value.signerAccounts[0] === activeSimulationAddress.value
				|| !simulationMode.value && activeSigningAddress.value !== undefined && tabState.value.signerAccounts[0] === activeSigningAddress.value
			)
	}

	async function setActiveRpcAndInformAboutIt(entry: RpcEntry) {
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: entry })
		if(!isSignerConnected()) {
			rpcNetwork.value = entry
		}
	}
	const requestActiveAddresses = async () => {
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestActiveAddresses' })
		if (reply === undefined) return
		activeAddresses.value = reply.activeAddresses
	}

	const requestSimulationMode = async () => {
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMode' })
		if (reply === undefined) return
		simulationMode.value = reply.simulationMode
	}

	const requestRichData = async () => {
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestMakeMeRichData' })
		if (reply === undefined) return
		fixedAddressRichList.value = reply.richList
		makeCurrentAddressRich.value = reply.makeCurrentAddressRich
	}

	const requestUnexpectedError = async () => {
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestLatestUnexpectedError' })
		if (reply === undefined) return
		unexpectedError.value = reply.latestUnexpectedError
	}

	useEffect(() => {
		requestActiveAddresses()
		requestRichData()
		requestSimulationMode()
		requestUnexpectedError()
	}, [])

	useEffect(() => {
		const setSimulationState = (
			simState: SimulationState | undefined,
			addressBookEntries: AddressBookEntries,
			tokenPriceEstimates: readonly TokenPriceEstimate[],
			visualizedSimulationState: VisualizedSimulationState,
			activeSimulationAddress: EthereumAddress | undefined,
			namedTokenIds: readonly NamedTokenId[],
		) => {
			if (activeSimulationAddress === undefined) return (simVisResults.value = undefined)
			if (simState === undefined) return (simVisResults.value = undefined)
			simVisResults.value = {
				blockNumber: simState.blockNumber,
				blockTimestamp: simState.blockTimestamp,
				simulationConductedTimestamp: simState.simulationConductedTimestamp,
				visualizedSimulationState,
				rpcNetwork: simState.rpcNetwork,
				tokenPriceEstimates,
				activeAddress: activeSimulationAddress,
				addressBookEntries: addressBookEntries,
				namedTokenIds,
			}
		}

		const updateVisualizedState = (state: CompleteVisualizedSimulation | undefined) => {
			if (state === undefined) return
			setSimulationState(
				state.simulationState,
				state.addressBookEntries,
				state.tokenPriceEstimates,
				state.visualizedSimulationState,
				activeSimulationAddress.value,
				state.namedTokenIds,
			)
			simulationUpdatingState.value = state.simulationUpdatingState
			simulationResultState.value = state.simulationResultState
		}

		const updateHomePage = ({ data }: UpdateHomePage) => {
			if (data.tabId !== currentTabId.value && currentTabId.value !== undefined) return
			const wasLoaded = isSettingsLoaded.value
			isSettingsLoaded.value = true
			rpcEntries.value = data.rpcEntries
			currentTabId.value = data.tabId
			activeSigningAddress.value = data.activeSigningAddressInThisTab
			interceptorDisabled.value = data.interceptorDisabled
			updateHomePageSettings(data.settings, !wasLoaded)
			if (!wasLoaded) tabIconDetails.value = data.tabState.tabIconDetails
			updateVisualizedState(data.visualizedSimulatorState)
			tabState.value = data.tabState
			currentBlockNumber.value = data.currentBlockNumber
			websiteAccessAddressMetadata.value = data.websiteAccessAddressMetadata
			rpcConnectionStatus.value = data.rpcConnectionStatus
			if (!wasLoaded) {
				preSimulationBlockTimeManipulation.value = data.preSimulationBlockTimeManipulation
			}
		}
		const updateHomePageSettings = (settings: Settings, updateQuery: boolean) => {
			if (updateQuery && appPage.value.page === 'Unknown') {
				if (settings.openedPage.page === 'AddNewAddress' || settings.openedPage.page === 'ModifyAddress') {
					appPage.value = { ...settings.openedPage, state: new Signal(settings.openedPage.state) }
				} else {
					appPage.value = settings.openedPage
				}
			}
			rpcNetwork.value = settings.activeRpcNetwork
			activeSimulationAddress.value = settings.activeSimulationAddress
			useSignersAddressAsActiveAddress.value = settings.useSignersAddressAsActiveAddress
			websiteAccess.value = settings.websiteAccess
		}

		const replyPopupMessageListener = (msg: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
			const maybeRequest = PopupMessageReplyRequests.safeParse(msg)
			if (maybeRequest.success && maybeRequest.value.method === 'popup_isMainPopupWindowOpen') {
				sendResponse({ type: 'RequestIsMainPopupWindowOpenReply', data: { isOpen: true } })
				return true
			}

			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return undefined // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.role === 'confirmTransaction') return undefined
			switch(parsed.method) {
					case 'popup_UnexpectedErrorOccured': {
						unexpectedError.value = parsed
						return undefined
					}
				case 'popup_settingsUpdated': {
					requestRichData()
					updateHomePageSettings(parsed.data, true)
					return undefined
				}
				case 'popup_activeSigningAddressChanged': {
					if (parsed.data.tabId !== currentTabId.value) return undefined
					activeSigningAddress.value = parsed.data.activeSigningAddress
					return undefined
				}
				case 'popup_websiteIconChanged': {
					tabIconDetails.value = parsed.data
					return undefined
				}
				case 'popup_new_block_arrived': {
					rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
					currentBlockNumber.value = parsed.data.rpcConnectionStatus?.latestBlock?.number
					return undefined
				}
				case 'popup_failed_to_get_block': {
					rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
					currentBlockNumber.value = parsed.data.rpcConnectionStatus?.latestBlock?.number
					return undefined
				}
				case 'popup_update_rpc_list': return undefined
				case 'popup_simulation_state_changed': {
					updateVisualizedState(parsed.data.visualizedSimulatorState)
					return undefined
				}
			}
			if (parsed.method !== 'popup_UpdateHomePage') {
				sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData' })
				return undefined
			}
			const { role: _role, ...popupUpdateHomePage } = parsed
			return updateHomePage(UpdateHomePage.parse(popupUpdateHomePage))
		}

		browser.runtime.onMessage.addListener(replyPopupMessageListener)
		return () => {
			browser.runtime.onMessage.removeListener(replyPopupMessageListener)
		}
	}, [])

	useEffect(() => {
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
	}, [])

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
		if (appPage.value !== undefined && appPage.value.page === 'AddNewAddress') return

		const trimmed = address.trim()
		if (!ethers.isAddress(trimmed)) return

		const bigIntReprentation = BigInt(trimmed)
		// see if we have that address, if so, let's switch to it
		for (const activeAddress of activeAddresses.value) {
			if (activeAddress.address === bigIntReprentation) return await setActiveAddressAndInformAboutIt(activeAddress.address)
		}

		// address not found, let's promt user to create it
		const addressString = ethers.getAddress(trimmed)
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
				chainId: rpcConnectionStatus.peek()?.rpcNetwork.chainId || 1n,
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
				chainId: rpcConnectionStatus.peek()?.rpcNetwork.chainId || 1n,
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
	function onRenderError(error: Error) { unexpectedError.value = { method: 'popup_UnexpectedErrorOccured', data: { message: error.message, timestamp: new Date() } } }
	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		boundaryResetKey.value += 1
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}

	const activeAddress = useComputed(() => simulationMode.value ? activeSimulationAddress.value : activeSigningAddress.value)

	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { appPage.value.page === 'Unknown' || appPage.value.page === 'Home' } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage.value.page !== 'Unknown' && appPage.value.page !== 'Home' ? 'overflow: hidden;' : 'overflow-y: auto; overflow-x: hidden' }` }>
					<nav class = 'navbar window-header' role = 'navigation' aria-label = 'main navigation'>
						<div class = 'navbar-brand'>
							<a class = 'navbar-item' style = 'cursor: unset'>
								<img src = '../img/LOGOA.svg' alt = 'Logo' width = '32'/>
								<p style = 'color: #FFFFFF; padding-left: 5px;'>THE INTERCEPTOR
									<span style = 'color: var(--unimportant-text-color); font-size: 0.8em; padding-left: 5px;' > { `${ version } - ${ gitCommitSha.slice(0, 8) }`  } </span>
								</p>
							</a>
							<a class = 'navbar-item' style = 'margin-left: auto; margin-right: 0;'>
								<img src = '../img/internet.svg' width = '32' onClick = { openWebsiteAccess }/>
								<img src = '../img/address-book.svg' width = '32' onClick = { openAddressBook }/>
								<img src = '../img/settings.svg' width = '32' onClick = { openSettings }/>
							</a>
						</div>
					</nav>

				<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value === undefined ? undefined : unexpectedError.value.data }/>
					<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
					<ProviderErrors tabState = { tabState }/>
					{ !isSettingsLoaded.value ? <CenterToPageTextSpinner/> : <>
						<Home
							setActiveRpcAndInformAboutIt = { setActiveRpcAndInformAboutIt }
							rpcNetwork = { rpcNetwork }
							simVisResults = { simVisResults }
							useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
							activeSigningAddress = { activeSigningAddress }
							activeSimulationAddress = { activeSimulationAddress }
							changeActiveAddress = { changeActiveAddress }
							makeCurrentAddressRich = { makeCurrentAddressRich }
							activeAddresses = { activeAddresses }
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
							openImportSimulation = { () => { appPage.value = { page: 'ImportSimulation', state: new Signal('') } } }
						/>

					</> }

					<div class = { `modal ${ appPage.value.page !== 'Home' && appPage.value.page !== 'Unknown' ? 'is-active' : ''}` }>
						{ appPage.value.page === 'EditEnsNamedHash' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><EditEnsLabelHash
								close = { goHome }
								editEnsNamedHashWindowState = { appPage.value.state }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'AccessList' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><InterceptorAccessList
								goHome = { goHome }
								websiteAccess = { websiteAccess }
								websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
								renameAddressCallBack = { renameAddressCallBack }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'ChangeActiveAddress' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><ChangeActiveAddress
								setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
								signerAccounts = { tabState.value?.signerAccounts ?? [] }
								close = { goHome }
								activeAddresses = { activeAddresses }
								signerName = { tabState.value?.signerName ?? 'NoSignerDetected' }
								renameAddressCallBack = { renameAddressCallBack }
								addNewAddress = { addNewAddress }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'AddNewAddress' || appPage.value.page === 'ModifyAddress' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><AddNewAddress
								setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
								modifyAddressWindowState = { appPage.value.state }
								close = { goHome }
								activeAddress = { activeAddress.value }
								rpcEntries = { rpcEntries }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'ImportSimulation' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><ImportSimulationStack
								close = { goHome }
								simulationInput = { appPage.value.state }
							/></ErrorBoundary>
						: <></> }
					</div>
				</div>
			</Hint>
		</main>
	)
}
