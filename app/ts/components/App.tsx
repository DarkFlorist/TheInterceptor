import { useState, useEffect } from 'preact/hooks'
import { defaultAddresses } from '../background/settings.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, SimulationState, TokenPriceEstimate, RpcEntry, RpcNetwork, RpcEntries } from '../utils/visualizer-types.js'
import { ChangeActiveAddress } from './pages/ChangeActiveAddress.js'
import { Home } from './pages/Home.js'
import { AddressInfo, AddressInfoEntry, AddressBookEntry, AddingNewAddressType, SignerName, AddressBookEntries } from '../utils/user-interface-types.js'
import Hint from './subcomponents/Hint.js'
import { AddNewAddress } from './pages/AddNewAddress.js'
import { InterceptorAccessList } from './pages/InterceptorAccessList.js'
import { ethers } from 'ethers'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import { DEFAULT_TAB_CONNECTION } from '../utils/constants.js'
import { ExternalPopupMessage, TabIconDetails, UpdateHomePage, Page, WebsiteAccessArray, WebsiteIconChanged, RpcConnectionStatus, Settings } from '../utils/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import { EthereumAddress } from '../utils/wire-types.js'
import { SettingsView } from './pages/SettingsView.js'

export function App() {
	const [appPage, setAppPage] = useState<Page>('Home')
	const [makeMeRich, setMakeMeRich] = useState(false)
	const [addressInfos, setAddressInfos] = useState<readonly AddressInfo[]>(defaultAddresses)
	const [signerAccounts, setSignerAccounts] = useState<readonly bigint[] | undefined>(undefined)
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<bigint | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<bigint | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simVisResults, setSimVisResults] = useState<SimulationAndVisualisationResults | undefined >(undefined)
	const [websiteAccess, setWebsiteAccess] = useState<WebsiteAccessArray | undefined>(undefined)
	const [websiteAccessAddressMetadata, setWebsiteAccessAddressMetadata] = useState<readonly AddressInfoEntry[]>([])
	const [rpcNetwork, setSelectedNetwork] = useState<RpcNetwork | undefined>(undefined)
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [isSettingsLoaded, setIsSettingsLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [signerName, setSignerName] = useState<SignerName>('NoSignerDetected')
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType> ({ addingAddress: true, type: 'addressInfo' })
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [useTabsInsteadOfPopup, setUseTabsInsteadOfPopup] = useState<boolean | undefined>(undefined)
	const [currentTabId, setCurrentTabId] = useState<number | undefined>(undefined)
	const [rpcEntries, setRpcEntries] = useState<RpcEntries>([])

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		setUseSignersAddressAsActiveAddress(address === 'signer')
		if (address === 'signer') {
			sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: 'signer', simulationMode: simulationMode } })
			if (simulationMode) {
				return setActiveSimulationAddress(signerAccounts && signerAccounts.length > 0 ? signerAccounts[0] : undefined)
			}
			return setActiveSigningAddress(signerAccounts && signerAccounts.length > 0 ? signerAccounts[0] : undefined)
		}
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: simulationMode } })
		if (simulationMode) {
			return setActiveSimulationAddress(address)
		}
		return setActiveSigningAddress(address)
	}

	function isSignerConnected() {
		return signerAccounts !== undefined && signerAccounts.length > 0
			&& (
				simulationMode && activeSimulationAddress !== undefined && signerAccounts[0] === activeSimulationAddress
				|| !simulationMode && activeSigningAddress !== undefined && signerAccounts[0] === activeSigningAddress
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
			activeSimulationAddress: EthereumAddress | undefined,
		) => {
			if (activeSimulationAddress === undefined) return setSimVisResults(undefined)
			if (simState === undefined) return setSimVisResults(undefined)
			setSimVisResults({
				blockNumber: simState.blockNumber,
				blockTimestamp: simState.blockTimestamp,
				simulationConductedTimestamp: simState.simulationConductedTimestamp,
				simulatedAndVisualizedTransactions: simulatedAndVisualizedTransactions,
				rpcNetwork: simState.rpcNetwork,
				tokenPrices: tokenPrices,
				activeAddress: activeSimulationAddress,
				addressMetaData: addressBookEntries,
			})
		}

		const updateHomePage = ({ data }: UpdateHomePage) => {
			if (data.tabId !== currentTabId && currentTabId !== undefined) return
			setIsSettingsLoaded((isSettingsLoaded) => {
				setRpcEntries(data.rpcEntries)
				updateHomePageSettings(data.settings, !isSettingsLoaded)
				setCurrentTabId(data.tabId)
				setActiveSigningAddress(data.activeSigningAddressInThisTab)
				if (isSettingsLoaded === false) {
					if (data.tabIconDetails === undefined) {
						setTabConnection(DEFAULT_TAB_CONNECTION)
					} else {
						setTabConnection(data.tabIconDetails)
					}
				}
				setSimulationState(
					data.simulation.simulationState,
					data.simulation.addressBookEntries,
					data.simulation.tokenPrices,
					data.simulation.simulatedAndVisualizedTransactions,
					data.simulation.activeAddress
				)
				setMakeMeRich(data.makeMeRich)
				setSignerName(data.signerName)
				setCurrentBlockNumber(data.currentBlockNumber)
				setWebsiteAccessAddressMetadata(data.websiteAccessAddressMetadata)
				setSignerAccounts(data.signerAccounts)
				setRpcConnectionStatus(data.rpcConnectionStatus)
				setUseTabsInsteadOfPopup(data.useTabsInsteadOfPopup)
				return true
			})
		}
		const updateHomePageSettings = (settings: Settings, updateQuery: boolean) => {
			if (updateQuery) {
				setSimulationMode(settings.simulationMode)
				setAppPage(settings.page)
			}
			setSelectedNetwork(settings.rpcNetwork)
			setActiveSimulationAddress(settings.activeSimulationAddress)
			setUseSignersAddressAsActiveAddress(settings.useSignersAddressAsActiveAddress)
			setAddressInfos(settings.userAddressBook.addressInfos)
			setWebsiteAccess(settings.websiteAccess)
		}

		const updateTabIcon = ({ data }: WebsiteIconChanged) => {
			setTabConnection(data)
		}

		const popupMessageListener = async (msg: unknown) => {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_settingsUpdated') return updateHomePageSettings(message.data, true)
			if (message.method === 'popup_activeSigningAddressChanged' && message.data.tabId === currentTabId) return setActiveSigningAddress(message.data.activeSigningAddress)
			if (message.method === 'popup_websiteIconChanged') return updateTabIcon(message)
			if (message.method === 'popup_failed_to_get_block') return setRpcConnectionStatus(message.data.rpcConnectionStatus)
			if (message.method === 'popup_update_rpc_list') return
			if (message.method !== 'popup_UpdateHomePage') return await sendPopupMessageToBackgroundPage( { method: 'popup_requestNewHomeData' } )
			return updateHomePage(message)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData' }) }, [])

	function setAndSaveAppPage(page: Page) {
		setAppPage(page)
		sendPopupMessageToBackgroundPage({ method: 'popup_changePage', data: page })
	}

	async function addressPaste(address: string) {
		if (appPage === 'AddNewAddress') return

		const trimmed = address.trim()
		if ( !ethers.isAddress(trimmed) ) return

		const bigIntReprentation = BigInt(trimmed)
		// see if we have that address, if so, let's switch to it
		for (const addressInfo of addressInfos) {
			if ( addressInfo.address === bigIntReprentation) {
				return await setActiveAddressAndInformAboutIt(addressInfo.address)
			}
		}

		// address not found, let's promt user to create it
		const addressString = ethers.getAddress(trimmed)
		setAndSaveAppPage('AddNewAddress')
		setAddingNewAddress({ addingAddress: false, entry: {
			type: 'addressInfo',
			name: `Pasted ${ truncateAddr(addressString) }`,
			address: bigIntReprentation,
			askForAddressAccess: true,
		} } )
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAndSaveAppPage('ModifyAddress')
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	async function openAddressBook() {
		await sendPopupMessageToBackgroundPage( { method: 'popup_openAddressBook' } )
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}
	
	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { appPage === 'Home' } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage !== 'Home' ? 'overflow: hidden;' : 'overflow-y: auto; overflow-x: hidden' }` }>
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
									<img src = '../img/internet.svg' width = '32' onClick = { () => setAndSaveAppPage('AccessList') }/>
									<img src = '../img/address-book.svg' width = '32' onClick = { openAddressBook }/>
									<img src = '../img/settings.svg' width = '32' onClick = { () => setAndSaveAppPage('Settings') }/>
								</a>
							</div>
						</nav>
						<Home
							setActiveRpcAndInformAboutIt = { setActiveRpcAndInformAboutIt }
							rpcNetwork = { rpcNetwork }
							simVisResults = { simVisResults }
							useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
							activeSigningAddress = { activeSigningAddress }
							activeSimulationAddress = { activeSimulationAddress }
							signerAccounts = { signerAccounts }
							setAndSaveAppPage = { setAndSaveAppPage }
							makeMeRich = { makeMeRich }
							addressInfos = { addressInfos }
							simulationMode = { simulationMode }
							tabIconDetails = { tabIconDetails }
							currentBlockNumber = { currentBlockNumber }
							signerName = { signerName }
							renameAddressCallBack = { renameAddressCallBack }
							rpcConnectionStatus = { rpcConnectionStatus }
							rpcEntries = { rpcEntries }
						/>

						<div class = { `modal ${ appPage !== 'Home' ? 'is-active' : ''}` }>
							{ appPage === 'Settings' ?
								<SettingsView
									setAndSaveAppPage = { setAndSaveAppPage }
									useTabsInsteadOfPopup = { useTabsInsteadOfPopup } 
								/>
							: <></> }
							{ appPage === 'AccessList' ?
								<InterceptorAccessList
									setAndSaveAppPage = { setAndSaveAppPage }
									setWebsiteAccess = { setWebsiteAccess }
									websiteAccess = { websiteAccess }
									websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
									renameAddressCallBack = { renameAddressCallBack }
								/>
							: <></> }
							{ appPage === 'ChangeActiveAddress' ?
								<ChangeActiveAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									signerAccounts = { signerAccounts }
									setAndSaveAppPage = { setAndSaveAppPage }
									addressInfos = { addressInfos }
									signerName = { signerName }
									renameAddressCallBack = { renameAddressCallBack }
								/>
							: <></> }
							{ appPage === 'AddNewAddress' || appPage === 'ModifyAddress' ?
								<AddNewAddress
									setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
									addingNewAddress = { addingNewAddress }
									close = { () => setAndSaveAppPage('Home') }
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
