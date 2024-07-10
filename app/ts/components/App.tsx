import { useState, useEffect } from 'preact/hooks'
import { defaultActiveAddresses } from '../background/settings.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, SimulationState, TokenPriceEstimate, SimulationUpdatingState, SimulationResultState, NamedTokenId } from '../types/visualizer-types.js'
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
import { UpdateHomePage, Settings, MessageToPopup, UnexpectedErrorOccured } from '../types/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import { AddressBookEntry, AddressBookEntries } from '../types/addressBookTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { Page } from '../types/exportedSettingsTypes.js'
import { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../types/rpc.js'
import { ErrorComponent, UnexpectedError } from './subcomponents/Error.js'
import { SignersLogoName } from './subcomponents/signers.js'
import { useSignal } from '@preact/signals'
import { SomeTimeAgo } from './subcomponents/SomeTimeAgo.js'
import { noNewBlockForOverTwoMins } from '../background/iconHandler.js'
import { humanReadableDate } from './ui-utils.js'
import { EditEnsLabelHash } from './pages/EditEnsLabelHash.js'

type ProviderErrorsParam = {
	tabState: TabState | undefined
}

function ProviderErrors({ tabState } : ProviderErrorsParam) {
	if (tabState === undefined || tabState.signerAccountError === undefined) return <></>
	if (tabState.signerAccountError.code === METAMASK_ERROR_USER_REJECTED_REQUEST) return <ErrorComponent warning = { true } text = { <>Could not get an account from <SignersLogoName signerName = { tabState.signerName } /> as user denied the request.</> }/>
	if (tabState.signerAccountError.code === METAMASK_ERROR_ALREADY_PENDING.error.code) return <ErrorComponent warning = { true } text = { <>There's a connection request pending on <SignersLogoName signerName = { tabState.signerName } />. Please review the request.</> }/>
	return <ErrorComponent warning = { true } text = { <><SignersLogoName signerName = { tabState.signerName } /> returned error: "{ tabState.signerAccountError.message }".</> }/>
}

type NetworkErrorParams = {
	rpcConnectionStatus: RpcConnectionStatus
}

export function NetworkErrors({ rpcConnectionStatus } : NetworkErrorParams) {
	if (rpcConnectionStatus === undefined) return <></>
	const nextConnectionAttempt = new Date(rpcConnectionStatus.lastConnnectionAttempt.getTime() + TIME_BETWEEN_BLOCKS * 1000)
	const retrying = useSignal((nextConnectionAttempt.getTime() - new Date().getTime()) > 0)
	return <>
		{ rpcConnectionStatus.isConnected === false && retrying.value ?
			<ErrorComponent warning = { true } text = {
				<>Unable to connect to { rpcConnectionStatus.rpcNetwork.name }. Retrying in <SomeTimeAgo priorTimestamp = { nextConnectionAttempt } countBackwards = { true }/> .</>
			}/>
		: <></> }
		{ rpcConnectionStatus.latestBlock !== undefined && noNewBlockForOverTwoMins(rpcConnectionStatus) && retrying.value  ?
			<ErrorComponent warning = { true } text = {
				<>The connected RPC ({ rpcConnectionStatus.rpcNetwork.name }) seem to be stuck at block { rpcConnectionStatus.latestBlock.number } (occured on: { humanReadableDate(rpcConnectionStatus.latestBlock.timestamp) }). Retrying in <SomeTimeAgo priorTimestamp = { nextConnectionAttempt } countBackwards = { true }/>.</>
			}/>
		: <></> }
	</>
}

export function App() {
	const [appPage, setAppPage] = useState<Page>({ page: 'Home' })
	const [makeMeRich, setMakeMeRich] = useState(false)
	const [activeAddresses, setActiveAddresses] = useState<AddressBookEntries>(defaultActiveAddresses)
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<bigint | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<bigint | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simVisResults, setSimVisResults] = useState<SimulationAndVisualisationResults | undefined >(undefined)
	const [websiteAccess, setWebsiteAccess] = useState<WebsiteAccessArray | undefined>(undefined)
	const [websiteAccessAddressMetadata, setWebsiteAccessAddressMetadata] = useState<AddressBookEntries>([])
	const [rpcNetwork, setSelectedNetwork] = useState<RpcNetwork | undefined>(undefined)
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [isSettingsLoaded, setIsSettingsLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [tabState, setTabState] = useState<TabState | undefined>(undefined)
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [currentTabId, setCurrentTabId] = useState<number | undefined>(undefined)
	const [rpcEntries, setRpcEntries] = useState<RpcEntries>([])
	const [simulationUpdatingState, setSimulationUpdatingState] = useState<SimulationUpdatingState | undefined>(undefined)
	const [simulationResultState, setSimulationResultState] = useState<SimulationResultState | undefined>(undefined)
	const [interceptorDisabled, setInterceptorDisabled] = useState<boolean>(false)
	const [unexpectedError, setUnexpectedError] = useState<UnexpectedErrorOccured | undefined>(undefined)

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		setUseSignersAddressAsActiveAddress(address === 'signer')
		if (address === 'signer') {
			sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: 'signer', simulationMode: simulationMode } })
			if (simulationMode) {
				return setActiveSimulationAddress(tabState && tabState.signerAccounts.length > 0 ? tabState.signerAccounts[0] : undefined)
			}
			return setActiveSigningAddress(tabState && tabState.signerAccounts.length > 0 ? tabState.signerAccounts[0] : undefined)
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: simulationMode } })
		if (simulationMode) {
			return setActiveSimulationAddress(address)
		}
		return setActiveSigningAddress(address)
	}

	function isSignerConnected() {
		return tabState !== undefined && tabState.signerAccounts.length > 0
			&& (
				simulationMode && activeSimulationAddress !== undefined && tabState.signerAccounts[0] === activeSimulationAddress
				|| !simulationMode && activeSigningAddress !== undefined && tabState.signerAccounts[0] === activeSigningAddress
			)
	}

	async function setActiveRpcAndInformAboutIt(entry: RpcEntry) {
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: entry })
		if(!isSignerConnected()) {
			setSelectedNetwork(entry)
		}
	}

	useEffect(() => {
		const setSimulationState = (
			simState: SimulationState | undefined,
			addressBookEntries: AddressBookEntries,
			tokenPrices: readonly TokenPriceEstimate[],
			simulatedAndVisualizedTransactions: readonly SimulatedAndVisualizedTransaction[],
			personalSignRequests: readonly VisualizedPersonalSignRequest[],
			activeSimulationAddress: EthereumAddress | undefined,
			namedTokenIds: readonly NamedTokenId[],
		) => {
			if (activeSimulationAddress === undefined) return setSimVisResults(undefined)
			if (simState === undefined) return setSimVisResults(undefined)
			setSimVisResults({
				blockNumber: simState.blockNumber,
				blockTimestamp: simState.blockTimestamp,
				simulationConductedTimestamp: simState.simulationConductedTimestamp,
				simulatedAndVisualizedTransactions,
				visualizedPersonalSignRequests: personalSignRequests,
				rpcNetwork: simState.rpcNetwork,
				tokenPrices,
				activeAddress: activeSimulationAddress,
				addressBookEntries: addressBookEntries,
				namedTokenIds,
			})
		}

		const updateHomePage = ({ data }: UpdateHomePage) => {
			if (data.tabId !== currentTabId && currentTabId !== undefined) return
			setIsSettingsLoaded((isSettingsLoaded) => {
				setRpcEntries(data.rpcEntries)
				setActiveAddresses(data.activeAddresses)
				setCurrentTabId(data.tabId)
				setActiveSigningAddress(data.activeSigningAddressInThisTab)
				setInterceptorDisabled(data.interceptorDisabled)
				updateHomePageSettings(data.settings, !isSettingsLoaded)
				setUnexpectedError(data.latestUnexpectedError)
				if (isSettingsLoaded === false) setTabConnection(data.tabState.tabIconDetails)
				if (data.visualizedSimulatorState !== undefined) {
					setSimulationState(
						data.visualizedSimulatorState.simulationState,
						data.visualizedSimulatorState.addressBookEntries,
						data.visualizedSimulatorState.tokenPrices,
						data.visualizedSimulatorState.simulatedAndVisualizedTransactions,
						data.visualizedSimulatorState.visualizedPersonalSignRequests,
						data.visualizedSimulatorState.activeAddress,
						data.visualizedSimulatorState.namedTokenIds,
					)
					setSimulationUpdatingState(data.visualizedSimulatorState.simulationUpdatingState)
					setSimulationResultState(data.visualizedSimulatorState.simulationResultState)
				}
				setMakeMeRich(data.makeMeRich)
				setTabState(data.tabState)
				setCurrentBlockNumber(data.currentBlockNumber)
				setWebsiteAccessAddressMetadata(data.websiteAccessAddressMetadata)
				setRpcConnectionStatus(data.rpcConnectionStatus)
				return true
			})
		}
		const updateHomePageSettings = (settings: Settings, updateQuery: boolean) => {
			if (updateQuery) setAppPage(settings.openedPage)
			setSimulationMode(settings.simulationMode)
			setSelectedNetwork(settings.currentRpcNetwork)
			setActiveSimulationAddress(settings.activeSimulationAddress)
			setUseSignersAddressAsActiveAddress(settings.useSignersAddressAsActiveAddress)
			setWebsiteAccess(settings.websiteAccess)
		}

		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			switch(parsed.method) {
				case 'popup_UnexpectedErrorOccured': return setUnexpectedError(parsed)
				case 'popup_settingsUpdated': return updateHomePageSettings(parsed.data, true)
				case 'popup_activeSigningAddressChanged': {
					if (parsed.data.tabId !== currentTabId) return
					return setActiveSigningAddress(parsed.data.activeSigningAddress)
				}
				case 'popup_websiteIconChanged': return setTabConnection(parsed.data)
				case 'popup_new_block_arrived': {
					await sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
					return setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				}
				case 'popup_failed_to_get_block': return setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				case 'popup_update_rpc_list': return 
				case 'popup_simulation_state_changed': return await sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
			}
			if (parsed.method !== 'popup_UpdateHomePage') return await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData' })
			return updateHomePage(UpdateHomePage.parse(parsed))
		}
		browser.runtime.onMessage.addListener(popupMessageListener)	
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' }) }, [])

	function setAndSaveAppPage(page: Page) {
		setAppPage(page)
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: page })
	}

	async function addressPaste(address: string) {
		if (appPage.page === 'AddNewAddress') return

		const trimmed = address.trim()
		if (!ethers.isAddress(trimmed)) return

		const bigIntReprentation = BigInt(trimmed)
		// see if we have that address, if so, let's switch to it
		for (const activeAddress of activeAddresses) {
			if (activeAddress.address === bigIntReprentation) return await setActiveAddressAndInformAboutIt(activeAddress.address)
		}

		// address not found, let's promt user to create it
		const addressString = ethers.getAddress(trimmed)
		setAndSaveAppPage({ page: 'AddNewAddress', state: {
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
			}
		} })
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAndSaveAppPage({ page: 'ModifyAddress', state: {
			windowStateId: 'appRename',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				askForAddressAccess: true,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				abi: undefined,
				useAsActiveAddress: false,
				declarativeNetRequestBlockMode: undefined,
				...entry,
				address: checksummedAddress(entry.address),
			}
		} })
	}

	function addNewAddress() {
		setAndSaveAppPage({ page: 'AddNewAddress', state: {
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
			}
		} })
	}

	function editEnsNamedHashCallBack(type: 'nameHash' | 'labelHash', nameHash: EthereumBytes32, name: string | undefined) {
		setAndSaveAppPage({ page: 'EditEnsNamedHash', state: { type, nameHash, name } })
	}

	async function openAddressBook() {
		await sendPopupMessageToBackgroundPage( { method: 'popup_openAddressBook' } )
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	async function openSettings() {
		await sendPopupMessageToBackgroundPage( { method: 'popup_openSettings' } )
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	async function clearUnexpectedError() {
		setUnexpectedError(undefined)
		await sendPopupMessageToBackgroundPage( { method: 'popup_clearUnexpectedError' } )
	}

	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { appPage.page === 'Home' } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage.page !== 'Home' ? 'overflow: hidden;' : 'overflow-y: auto; overflow-x: hidden' }` }>
					{ !isSettingsLoaded ? <></> : <>
						<nav class = 'navbar window-header' role = 'navigation' aria-label = 'main navigation'>
							<div class = 'navbar-brand'>
								<a class = 'navbar-item' style = 'cursor: unset'>
									<img src = '../img/LOGOA.svg' alt = 'Logo' width = '32'/>
									<p style = 'color: #FFFFFF; padding-left: 5px;'>THE INTERCEPTOR
										<span style = 'color: var(--unimportant-text-color); font-size: 0.8em; padding-left: 5px;' > { ` alpha ${ version } - ${ gitCommitSha.slice(0, 8) }`  } </span>
									</p>
								</a>
								<a class = 'navbar-item' style = 'margin-left: auto; margin-right: 0;'>
									<img src = '../img/internet.svg' width = '32' onClick = { () => setAndSaveAppPage({ page: 'AccessList' }) }/>
									<img src = '../img/address-book.svg' width = '32' onClick = { openAddressBook }/>
									<img src = '../img/settings.svg' width = '32' onClick = { openSettings }/>
								</a>
							</div>
						</nav>
						
						<UnexpectedError close = { clearUnexpectedError } unexpectedError = { unexpectedError }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						<ProviderErrors tabState = { tabState }/>
						<Home
							setActiveRpcAndInformAboutIt = { setActiveRpcAndInformAboutIt }
							rpcNetwork = { rpcNetwork }
							simVisResults = { simVisResults }
							useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
							activeSigningAddress = { activeSigningAddress }
							activeSimulationAddress = { activeSimulationAddress }
							setAndSaveAppPage = { setAndSaveAppPage }
							makeMeRich = { makeMeRich }
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
						/>

						<div class = { `modal ${ appPage.page !== 'Home' ? 'is-active' : ''}` }>
							{ appPage.page === 'EditEnsNamedHash' ? 
								<EditEnsLabelHash
									close = { () => setAndSaveAppPage({ page: 'Home' }) }
									editEnsNamedHashWindowState = { appPage.state }
								/>
							: <></> }
							{ appPage.page === 'AccessList' ?
								<InterceptorAccessList
									setAndSaveAppPage = { setAndSaveAppPage }
									setWebsiteAccess = { setWebsiteAccess }
									websiteAccess = { websiteAccess }
									websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
									renameAddressCallBack = { renameAddressCallBack }
								/>
							: <></> }
							{ appPage.page === 'ChangeActiveAddress' ?
								<ChangeActiveAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									signerAccounts = { tabState?.signerAccounts ?? [] }
									setAndSaveAppPage = { setAndSaveAppPage }
									activeAddresses = { activeAddresses }
									signerName = { tabState?.signerName ?? 'NoSignerDetected' }
									renameAddressCallBack = { renameAddressCallBack }
									addNewAddress = { addNewAddress }
								/>
							: <></> }
							{ appPage.page === 'AddNewAddress' || appPage.page === 'ModifyAddress' ?
								<AddNewAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									modifyAddressWindowState = { appPage.state }
									close = { () => setAndSaveAppPage({ page: 'Home' }) }
									activeAddress = { simulationMode ? activeSimulationAddress : activeSigningAddress }
								/>
							: <></> }
						</div>
					</> }
				</div>
			</Hint>
		</main>
	)
}
