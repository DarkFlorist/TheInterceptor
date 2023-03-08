import { useState, useEffect } from 'preact/hooks'
import { defaultAddresses } from '../background/settings.js'
import { SimResults, SimulationAndVisualisationResults, SimulationState, TokenPriceEstimate } from '../utils/visualizer-types.js'
import { ChangeActiveAddress } from './pages/ChangeActiveAddress.js'
import { Home } from './pages/Home.js'
import { AddressInfo, AddressInfoEntry, AddressBookEntry, AddingNewAddressType, AddressBookEntries, PendingAccessRequestArray } from '../utils/user-interface-types.js'
import Hint from './subcomponents/Hint.js'
import { AddNewAddress } from './pages/AddNewAddress.js'
import { InterceptorAccessList } from './pages/InterceptorAccessList.js'
import { ethers } from 'ethers'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import { NotificationCenter } from './pages/NotificationCenter.js'
import { DEFAULT_TAB_CONNECTION } from '../utils/constants.js'
import { ExternalPopupMessage, SignerName, TabIconDetails, UpdateHomePage, Page, WebsiteAccessArray } from '../utils/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { formSimulatedAndVisualizedTransaction } from './formVisualizerResults.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import { addressString } from '../utils/bigint.js'
import { EthereumAddress } from '../utils/wire-types.js'

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
	const [activeChain, setActiveChain] = useState<bigint>(1n)
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [pendingAccessRequests, setPendingAccessRequests] = useState<PendingAccessRequestArray | undefined>(undefined)
	const [pendingAccessMetadata, setPendingAccessMetadata] = useState<readonly [string, AddressInfoEntry][]>([])
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [isSettingsLoaded, setIsSettingsLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [signerName, setSignerName] = useState<SignerName | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType> ({ addingAddress: true, type: 'addressInfo' as const })

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		setUseSignersAddressAsActiveAddress(address === 'signer')
		if( address === 'signer' ) {
			sendPopupMessageToBackgroundPage( { method: 'popup_changeActiveAddress', options: 'signer' } )
			if(simulationMode) {
				return setActiveSimulationAddress(signerAccounts && signerAccounts.length > 0 ? signerAccounts[0] : undefined)
			}
			return setActiveSigningAddress(signerAccounts && signerAccounts.length > 0 ? signerAccounts[0] : undefined)
		}
		sendPopupMessageToBackgroundPage( { method: 'popup_changeActiveAddress', options: address } )
		if(simulationMode) {
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

	async function setActiveChainAndInformAboutIt(chainId: bigint) {
		sendPopupMessageToBackgroundPage( { method: 'popup_changeActiveChain', options: chainId } )
		if(!isSignerConnected()) {
			setActiveChain(chainId)
		}
	}

	function setSimulationState(
		simState: SimulationState | undefined,
		visualizerResults: readonly SimResults[] | undefined,
		addressBookEntries: AddressBookEntries,
		tokenPrices: readonly TokenPriceEstimate[],
		activeSimulationAddress: EthereumAddress | undefined,
		simulationMode: boolean,
	) {
		if (simState === undefined) return setSimVisResults(undefined)
		if (visualizerResults === undefined) return setSimVisResults(undefined)
		if (activeSimulationAddress === undefined) return setSimVisResults(undefined)

		const addressMetaData = new Map(addressBookEntries.map( (x) => [addressString(x.address), x]))
		const txs = formSimulatedAndVisualizedTransaction(simState, visualizerResults, addressMetaData)
		setSimVisResults( {
			blockNumber: simState.blockNumber,
			blockTimestamp: simState.blockTimestamp,
			simulationConductedTimestamp: simState.simulationConductedTimestamp,
			simulatedAndVisualizedTransactions: txs,
			chain: simState.chain,
			tokenPrices: tokenPrices,
			activeAddress: activeSimulationAddress,
			simulationMode: simulationMode,
			addressMetaData: addressBookEntries,
		})
	}

	async function updateHomePage({ data }: UpdateHomePage) {
		const settings = data.settings
		setSimulationState(
			data.simulation.simulationState,
			data.simulation.visualizerResults,
			data.simulation.addressBookEntries,
			data.simulation.tokenPrices,
			settings.activeSimulationAddress,
			settings.simulationMode,
		)

		setActiveSimulationAddress(settings.activeSimulationAddress)
		setActiveSigningAddress(settings.activeSigningAddress)
		setUseSignersAddressAsActiveAddress(settings.useSignersAddressAsActiveAddress)
		setAddressInfos(settings.userAddressBook.addressInfos)
		setAppPage(settings.page)
		setMakeMeRich(settings.makeMeRich)
		setWebsiteAccess(settings.websiteAccess)

		setWebsiteAccessAddressMetadata(data.websiteAccessAddressMetadata)
		setActiveChain(settings.activeChain)
		setSimulationMode(settings.simulationMode !== undefined ? settings.simulationMode : true)
		setPendingAccessRequests(settings.pendingAccessRequests)
		setPendingAccessMetadata(data.pendingAccessMetadata)

		setSignerName(data.signerName)
		setCurrentBlockNumber(data.currentBlockNumber)

		setSignerAccounts(data.signerAccounts)
		if (data.tabIconDetails === undefined) {
			setTabConnection(DEFAULT_TAB_CONNECTION)
		} else {
			setTabConnection(data.tabIconDetails)
		}
		setIsSettingsLoaded(true)
	}

	useEffect(  () => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method !== 'popup_UpdateHomePage') return sendPopupMessageToBackgroundPage( { method: 'popup_requestNewHomeData' } )
			await updateHomePage(message)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_requestNewHomeData' } )
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	function setAndSaveAppPage(page: Page) {
		setAppPage(page)
		sendPopupMessageToBackgroundPage( { method: 'popup_changePage', options: page } )
	}

	async function addressPaste(address: string) {
		if (appPage === 'AddNewAddress') return

		const trimmed = address.trim()
		if ( !ethers.utils.isAddress(trimmed) ) return

		const bigIntReprentation = BigInt(trimmed)
		// see if we have that address, if so, let's switch to it
		for (const addressInfo of addressInfos) {
			if ( addressInfo.address === bigIntReprentation) {
				return await setActiveAddressAndInformAboutIt(addressInfo.address)
			}
		}

		// address not found, let's promt user to create it
		const addressString = ethers.utils.getAddress(trimmed)
		setAndSaveAppPage('AddNewAddress')
		setAddingNewAddress({ addingAddress: false, entry: {
			type: 'addressInfo' as const,
			name: `Pasted ${ truncateAddr(addressString) }`,
			address: bigIntReprentation,
			askForAddressAccess: true,
		} } )
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAndSaveAppPage('ModifyAddress')
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function openAddressBook() {
		sendPopupMessageToBackgroundPage( { method: 'popup_openAddressBook' } )
		return globalThis.close() // close extension popup, chrome closes it by default, but firefox does not
	}

	return (
		<main>
			<Hint>
				<PasteCatcher enabled = { appPage === 'Home' } onPaste = { addressPaste } />
				<div style = { `background-color: var(--bg-color); width: 520px; height: 600px; ${ appPage !== 'Home' ? 'overflow: hidden;' : 'overflow: auto;' }` }>
					{ !isSettingsLoaded ? <></> : <>
						<nav class = 'navbar window-header' role = 'navigation' aria-label = 'main navigation'>
							<div class = 'navbar-brand'>
								<a class = 'navbar-item' style = 'cursor: unset'>
									<img src = '../img/LOGOA.svg' alt = 'Logo' width = '32'/>
									<p style = 'color: #FFFFFF; padding-left: 5px;'>THE INTERCEPTOR
										<span style = 'color: var(--unimportant-text-color);' > { ` alpha ${ version } - ${ gitCommitSha.slice(0, 8) }`  } </span>
									</p>
								</a>
								<a class = 'navbar-item' style = 'margin-left: auto; margin-right: 0;'>
									<img src = '../img/internet.svg' width = '32' onClick = { () => setAndSaveAppPage('AccessList') }/>
									<img src = '../img/address-book.svg' width = '32' onClick = { openAddressBook }/>
									<div>
										<img src = '../img/notification-bell.svg' width = '32' onClick = { () => setAndSaveAppPage('NotificationCenter') }/>
										{ pendingAccessRequests === undefined || pendingAccessRequests.length <= 0 ? <> </> : <span class = 'badge' style = 'transform: translate(-75%, 75%);'> { pendingAccessRequests.length } </span> }
									</div>
								</a>
							</div>
						</nav>
						<Home
							setActiveChainAndInformAboutIt = { setActiveChainAndInformAboutIt }
							activeChain = { activeChain }
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
						/>

						<div class = { `modal ${ appPage !== 'Home' ? 'is-active' : ''}` }>
							{ appPage === 'NotificationCenter' ?
								<NotificationCenter
									setAndSaveAppPage = { setAndSaveAppPage }
									renameAddressCallBack = { renameAddressCallBack }
									pendingAccessRequests = { pendingAccessRequests }
									pendingAccessMetadata = { pendingAccessMetadata }
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
