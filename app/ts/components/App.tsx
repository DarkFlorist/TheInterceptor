import { useState, useEffect } from 'preact/hooks'
import { defaultActiveAddresses } from '../background/settings.js'
import { SimulationAndVisualisationResults, SimulationState, TokenPriceEstimate, SimulationUpdatingState, SimulationResultState, NamedTokenId, ModifyAddressWindowState, EditEnsNamedHashWindowState, VisualizedSimulationState, BlockTimeManipulation } from '../types/visualizer-types.js'
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
import { sendPopupMessageToBackgroundPage, sendPopupMessageToBackgroundPageWithReply } from '../background/backgroundUtils.js'
import { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import { AddressBookEntry, AddressBookEntries } from '../types/addressBookTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../types/rpc.js'
import { ErrorComponent, UnexpectedError } from './subcomponents/Error.js'
import { SignersLogoName } from './subcomponents/signers.js'
import { SomeTimeAgo } from './subcomponents/SomeTimeAgo.js'
import { noNewBlockForOverTwoMins } from '../background/iconHandler.js'
import { humanReadableDate } from './ui-utils.js'
import { EditEnsLabelHash } from './pages/EditEnsLabelHash.js'
import { Signal, useSignal, useSignalEffect } from '@preact/signals'

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

export function App() {
	const appPage = useSignal<Page>({ page: 'Unknown' })
	const activeAddresses = useSignal<AddressBookEntries>(defaultActiveAddresses)
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<bigint | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<bigint | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simVisResults, setSimVisResults] = useState<SimulationAndVisualisationResults | undefined >(undefined)
	const [websiteAccess, setWebsiteAccess] = useState<WebsiteAccessArray | undefined>(undefined)
	const [websiteAccessAddressMetadata, setWebsiteAccessAddressMetadata] = useState<AddressBookEntries>([])
	const rpcNetwork = useSignal<RpcNetwork | undefined>(undefined)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [isSettingsLoaded, setIsSettingsLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [tabState, setTabState] = useState<TabState | undefined>(undefined)
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const [currentTabId, setCurrentTabId] = useState<number | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])
	const [simulationUpdatingState, setSimulationUpdatingState] = useState<SimulationUpdatingState | undefined>(undefined)
	const [simulationResultState, setSimulationResultState] = useState<SimulationResultState | undefined>(undefined)
	const [interceptorDisabled, setInterceptorDisabled] = useState<boolean>(false)
	const unexpectedError = useSignal<UnexpectedErrorOccured | undefined>(undefined)
	const preSimulationBlockTimeManipulation = useSignal<BlockTimeManipulation | undefined>(undefined)

	const makeMeRichList = useSignal<readonly AddressBookEntry[]>([])
	const makeMeRich = useSignal<boolean>(false)
	const keepSelectedAddressRichEvenIfIChangeAddress = useSignal<boolean>(false)
	const simulationMode = useSignal<boolean>(false)

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		setUseSignersAddressAsActiveAddress(address === 'signer')
		if (address === 'signer') {
			sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: 'signer', simulationMode: simulationMode.value } })
			if (simulationMode.value) {
				return setActiveSimulationAddress(tabState && tabState.signerAccounts.length > 0 ? tabState.signerAccounts[0] : undefined)
			}
			return setActiveSigningAddress(tabState && tabState.signerAccounts.length > 0 ? tabState.signerAccounts[0] : undefined)
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: simulationMode.value } })
		if (simulationMode.value) {
			return setActiveSimulationAddress(address)
		}
		return setActiveSigningAddress(address)
	}

	function isSignerConnected() {
		return tabState !== undefined && tabState.signerAccounts.length > 0
			&& (
				simulationMode.value && activeSimulationAddress !== undefined && tabState.signerAccounts[0] === activeSimulationAddress
				|| !simulationMode.value && activeSigningAddress !== undefined && tabState.signerAccounts[0] === activeSigningAddress
			)
	}

	async function setActiveRpcAndInformAboutIt(entry: RpcEntry) {
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: entry })
		if(!isSignerConnected()) {
			rpcNetwork.value = entry
		}
	}

	const requestActiveAddresses = async () => {
		const reply = await sendPopupMessageToBackgroundPageWithReply({ method: 'popup_requestActiveAddresses' })
		if (reply === undefined) return
		activeAddresses.value = reply.activeAddresses
	}

	const requestSimulationMode = async () => {
		const reply = await sendPopupMessageToBackgroundPageWithReply({ method: 'popup_requestSimulationMode' })
		if (reply === undefined) return
		simulationMode.value = reply.simulationMode
	}

	const requestRichData = async () => {
		const reply = await sendPopupMessageToBackgroundPageWithReply({ method: 'popup_requestMakeMeRichData' })
		if (reply === undefined) return
		makeMeRichList.value = reply.richList
		makeMeRich.value = reply.makeMeRich
		keepSelectedAddressRichEvenIfIChangeAddress.value = reply.keepSelectedAddressRichEvenIfIChangeAddress
	}

	const requestUnexpectedError = async () => {
		const reply = await sendPopupMessageToBackgroundPageWithReply({ method: 'popup_requestLatestUnexpectedError' })
		if (reply === undefined) return
		unexpectedError.value = reply.latestUnexpectedError
	}

	useEffect(() => {
		requestRichData()
		requestSimulationMode()
		requestActiveAddresses()
		requestUnexpectedError()
	}, [])

	useSignalEffect(() => {
		activeAddresses.value
		requestRichData()
	})

	useEffect(() => {
		const setSimulationState = (
			simState: SimulationState | undefined,
			addressBookEntries: AddressBookEntries,
			tokenPriceEstimates: readonly TokenPriceEstimate[],
			visualizedSimulationState: VisualizedSimulationState,
			activeSimulationAddress: EthereumAddress | undefined,
			namedTokenIds: readonly NamedTokenId[],
		) => {
			if (activeSimulationAddress === undefined) return setSimVisResults(undefined)
			if (simState === undefined) return setSimVisResults(undefined)
			setSimVisResults({
				blockNumber: simState.blockNumber,
				blockTimestamp: simState.blockTimestamp,
				simulationConductedTimestamp: simState.simulationConductedTimestamp,
				visualizedSimulationState,
				rpcNetwork: simState.rpcNetwork,
				tokenPriceEstimates,
				activeAddress: activeSimulationAddress,
				addressBookEntries: addressBookEntries,
				namedTokenIds,
			})
		}

		const updateHomePage = ({ data }: UpdateHomePage) => {
			if (data.tabId !== currentTabId && currentTabId !== undefined) return
			setIsSettingsLoaded((isSettingsLoaded) => {
				rpcEntries.value = data.rpcEntries
				setCurrentTabId(data.tabId)
				setActiveSigningAddress(data.activeSigningAddressInThisTab)
				setInterceptorDisabled(data.interceptorDisabled)
				updateHomePageSettings(data.settings, !isSettingsLoaded)
				if (isSettingsLoaded === false) setTabConnection(data.tabState.tabIconDetails)
				if (data.visualizedSimulatorState !== undefined) {
					setSimulationState(
						data.visualizedSimulatorState.simulationState,
						data.visualizedSimulatorState.addressBookEntries,
						data.visualizedSimulatorState.tokenPriceEstimates,
						data.visualizedSimulatorState.visualizedSimulationState,
						data.visualizedSimulatorState.activeAddress,
						data.visualizedSimulatorState.namedTokenIds,
					)
					setSimulationUpdatingState(data.visualizedSimulatorState.simulationUpdatingState)
					setSimulationResultState(data.visualizedSimulatorState.simulationResultState)
				}
				setTabState(data.tabState)
				setCurrentBlockNumber(data.currentBlockNumber)
				setWebsiteAccessAddressMetadata(data.websiteAccessAddressMetadata)
				rpcConnectionStatus.value = data.rpcConnectionStatus
				if (!isSettingsLoaded) {
					preSimulationBlockTimeManipulation.value = data.preSimulationBlockTimeManipulation
				}
				return true
			})
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
			setActiveSimulationAddress(settings.activeSimulationAddress)
			setUseSignersAddressAsActiveAddress(settings.useSignersAddressAsActiveAddress)
			setWebsiteAccess(settings.websiteAccess)
		}

		const popupMessageListener = (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			switch(parsed.method) {
				case 'popup_UnexpectedErrorOccured': {
					unexpectedError.value = parsed
					return
				}
				case 'popup_settingsUpdated': return updateHomePageSettings(parsed.data, true)
				case 'popup_activeSigningAddressChanged': {
					if (parsed.data.tabId !== currentTabId) return
					return setActiveSigningAddress(parsed.data.activeSigningAddress)
				}
				case 'popup_websiteIconChanged': return setTabConnection(parsed.data)
				case 'popup_new_block_arrived': {
					sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
					rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
					return
				}
				case 'popup_failed_to_get_block': {
					rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
					return
				}
				case 'popup_update_rpc_list': return
				case 'popup_simulation_state_changed': return sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
			}
			if (parsed.method !== 'popup_UpdateHomePage') return sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData' })
			return updateHomePage(UpdateHomePage.parse(parsed))
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' }) }, [])

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
		const newPage = { page: 'ModifyAddress', state: {
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
				chainId: entry.chainId || 1n,
				...entry,
				address: checksummedAddress(entry.address),
			}
		} } as const
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
			}}
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
	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}
	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { appPage.value.page === 'Unknown' || appPage.value.page === 'Home' } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage.value.page !== 'Unknown' && appPage.value.page !== 'Home' ? 'overflow: hidden;' : 'overflow-y: auto; overflow-x: hidden' }` }>
					{ !isSettingsLoaded ? <></> : <>
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
							changeActiveAddress = { changeActiveAddress }
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
							preSimulationBlockTimeManipulation = { preSimulationBlockTimeManipulation }
							makeMeRichList = { makeMeRichList }
							keepSelectedAddressRichEvenIfIChangeAddress = { keepSelectedAddressRichEvenIfIChangeAddress }
						/>

						<div class = { `modal ${ appPage.value.page !== 'Home' && appPage.value.page !== 'Unknown' ? 'is-active' : ''}` }>
							{ appPage.value.page === 'EditEnsNamedHash' ?
								<EditEnsLabelHash
									close = { goHome }
									editEnsNamedHashWindowState = { appPage.value.state }
								/>
							: <></> }
							{ appPage.value.page === 'AccessList' ?
								<InterceptorAccessList
									goHome = { goHome }
									setWebsiteAccess = { setWebsiteAccess }
									websiteAccess = { websiteAccess }
									websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
									renameAddressCallBack = { renameAddressCallBack }
								/>
							: <></> }
							{ appPage.value.page === 'ChangeActiveAddress' ?
								<ChangeActiveAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									signerAccounts = { tabState?.signerAccounts ?? [] }
									close = { goHome }
									activeAddresses = { activeAddresses }
									signerName = { tabState?.signerName ?? 'NoSignerDetected' }
									renameAddressCallBack = { renameAddressCallBack }
									addNewAddress = { addNewAddress }
								/>
							: <></> }
							{ appPage.value.page === 'AddNewAddress' || appPage.value.page === 'ModifyAddress' ?
								<AddNewAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									modifyAddressWindowState = { appPage.value.state }
									close = { goHome }
									activeAddress = { simulationMode ? activeSimulationAddress : activeSigningAddress }
									rpcEntries = { rpcEntries }
								/>
							: <></> }
						</div>
					</> }
				</div>
			</Hint>
		</main>
	)
}
