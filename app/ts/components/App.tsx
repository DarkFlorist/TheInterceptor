import { useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import { defaultActiveAddresses } from '../background/settings.js'
import { PASSTHROUGH_STATE, ResolvedSimulationResults, ResolvedSimulationState, TokenPriceEstimate, SimulationUpdatingState, SimulationResultState, NamedTokenId, ModifyAddressWindowState, EditEnsNamedHashWindowState, VisualizedSimulationState, BlockTimeManipulation, CompleteVisualizedSimulation, toResolvedSimulationResults } from '../types/visualizer-types.js'
import { Home } from './pages/Home.js'
import { RpcConnectionStatus, TabIconDetails, TabState } from '../types/user-interface-types.js'
import Hint from './subcomponents/Hint.js'
import { getAddress, isAddress } from 'viem/utils'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import { DEFAULT_TAB_CONNECTION, METAMASK_ERROR_ALREADY_PENDING, METAMASK_ERROR_USER_REJECTED_REQUEST, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { UpdateHomePage, Settings, MessageToPopup } from '../types/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
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
import { Signal, useComputed, useSignal } from '@preact/signals'
import type { EnrichedRichListElement, UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { PopupMessageReplyRequests } from '../types/interceptor-reply-messages.js'
import { CenterToPageTextSpinner } from './subcomponents/Spinner.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance, markPerformanceOnce } from '../utils/popupPerformance.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import type { AddAddressParam, ChangeActiveAddressParam, InterceptorAccessListParams } from '../types/user-interface-types.js'

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

type LazyPageComponent<T extends object> = ((props: T) => JSX.Element) | undefined
type LazyPageModule<T extends object, ExportName extends string> = Record<ExportName, (props: T) => JSX.Element>

function useLazyPage<T extends object, ExportName extends string>(loader: () => Promise<LazyPageModule<T, ExportName>>, exportName: ExportName) {
	const component = useSignal<LazyPageComponent<T>>(undefined)
	useEffect(() => {
		let cancelled = false
		void loader().then((module) => {
			if (cancelled) return
			component.value = module[exportName]
		})
		return () => {
			cancelled = true
		}
	}, [])
	return component
}

function createLazyPage<T extends object, ExportName extends string>(loader: () => Promise<LazyPageModule<T, ExportName>>, exportName: ExportName) {
	return function LazyPage(props: T) {
		const component = useLazyPage(loader, exportName)
		if (component.value === undefined) return <CenterToPageTextSpinner />
		const Component = component.value
		return <Component { ...props } />
	}
}

const LazyChangeActiveAddress = createLazyPage<ChangeActiveAddressParam, 'ChangeActiveAddress'>(
	() => import('./pages/ChangeActiveAddress.js'),
	'ChangeActiveAddress',
)

const LazyAddNewAddress = createLazyPage<AddAddressParam, 'AddNewAddress'>(
	() => import('./pages/AddNewAddress.js'),
	'AddNewAddress',
)

const LazyInterceptorAccessList = createLazyPage<InterceptorAccessListParams, 'InterceptorAccessList'>(
	() => import('./pages/InterceptorAccessList.js'),
	'InterceptorAccessList',
)

const LazyEditEnsLabelHash = createLazyPage<{ close: () => void, editEnsNamedHashWindowState: EditEnsNamedHashWindowState }, 'EditEnsLabelHash'>(
	() => import('./pages/EditEnsLabelHash.js'),
	'EditEnsLabelHash',
)

const LazyImportSimulationStack = createLazyPage<{ close: () => void, simulationInput: Signal<string> }, 'ImportSimulationStack'>(
	() => import('./pages/ImportSimulationStack.js'),
	'ImportSimulationStack',
)

export function App() {
	const appPage = useSignal<Page>({ page: 'Unknown' })
	const activeAddresses = useSignal<AddressBookEntries>(defaultActiveAddresses)
	const activeSimulationAddress = useSignal<bigint | undefined>(undefined)
	const activeSigningAddress = useSignal<bigint | undefined>(undefined)
	const useSignersAddressAsActiveAddress = useSignal<boolean>(false)
	const simVisResults = useSignal<ResolvedSimulationResults>(PASSTHROUGH_STATE)
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
	const popupRefreshAppliedGeneration = useSignal(0)

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
	const requestCachedHomeData = async () => {
		await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData' })
	}

	useEffect(() => {
		if (popupRefreshAppliedGeneration.value === 0) return
		if (popupRefreshAppliedGeneration.value === 1) {
			markPerformanceOnce(POPUP_PERFORMANCE_MARKS.homeFirstCommit)
		}
		markPerformanceOnce(POPUP_PERFORMANCE_MARKS.refreshRendered)
	}, [popupRefreshAppliedGeneration.value])

	useEffect(() => {
		const setSimulationState = (
			simState: ResolvedSimulationState,
			addressBookEntries: AddressBookEntries,
			tokenPriceEstimates: readonly TokenPriceEstimate[],
			visualizedSimulationState: VisualizedSimulationState,
			activeSimulationAddress: EthereumAddress | undefined,
			namedTokenIds: readonly NamedTokenId[],
		): void => {
			if (activeSimulationAddress === undefined || simState.kind === 'passthrough') {
				simVisResults.value = PASSTHROUGH_STATE
				return
			}
			simVisResults.value = toResolvedSimulationResults({
				blockNumber: simState.value.blockNumber,
				blockTimestamp: simState.value.blockTimestamp,
				simulationConductedTimestamp: simState.value.simulationConductedTimestamp,
				simulationStateInput: simState.value.simulationStateInput,
				visualizedSimulationState,
				rpcNetwork: simState.value.rpcNetwork,
				tokenPriceEstimates,
				addressBookEntries: addressBookEntries,
				namedTokenIds,
			})
		}

		const updateVisualizedState = (state: CompleteVisualizedSimulation) => {
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
			activeAddresses.value = data.activeAddresses
			interceptorDisabled.value = data.interceptorDisabled
			makeCurrentAddressRich.value = data.makeCurrentAddressRich
			fixedAddressRichList.value = data.richList
			unexpectedError.value = data.latestUnexpectedError
			updateHomePageSettings(data.settings, !wasLoaded)
			tabIconDetails.value = data.tabState.tabIconDetails
			updateVisualizedState(data.visualizedSimulatorState)
			tabState.value = data.tabState
			currentBlockNumber.value = data.currentBlockNumber
			websiteAccessAddressMetadata.value = data.websiteAccessAddressMetadata
			rpcConnectionStatus.value = data.rpcConnectionStatus
			preSimulationBlockTimeManipulation.value = data.preSimulationBlockTimeManipulation
			markPerformance(POPUP_PERFORMANCE_MARKS.refreshComplete)
			popupRefreshAppliedGeneration.value += 1
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
			simulationMode.value = settings.simulationMode
		}

		const replyPopupMessageListener = (msg: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
			const maybeRequest = PopupMessageReplyRequests.safeParse(msg)
			if (maybeRequest.success && maybeRequest.value.method === 'popup_isMainPopupWindowOpen') {
				sendResponse({ method: 'popup_isMainPopupWindowOpen', data: { isOpen: true } })
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
					case 'popup_settingsUpdated':
					case 'popup_accounts_update':
					case 'popup_chain_update':
					case 'popup_signer_name_changed':
					case 'popup_addressBookEntriesChanged':
					case 'popup_interceptor_access_changed':
					case 'popup_websiteAccess_changed':
					case 'popup_setDisableInterceptorReply':
					case 'popup_update_rpc_list':
						requestCachedHomeData()
						return undefined
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
					case 'popup_simulation_state_changed': {
						updateVisualizedState(parsed.data.visualizedSimulatorState)
						return undefined
					}
				}
				if (parsed.method !== 'popup_UpdateHomePage') {
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
		void (async () => {
			await requestCachedHomeData()
			void sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
		})()
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
	function onRenderError(error: Error) { unexpectedError.value = { method: 'popup_UnexpectedErrorOccured', data: { message: error.message, timestamp: new Date(), source: 'popup', code: 'render_error', debugId: undefined } } }
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
								<p style = 'color: var(--text-color); padding-left: 5px;'>THE INTERCEPTOR
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
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><LazyEditEnsLabelHash
								close = { goHome }
								editEnsNamedHashWindowState = { appPage.value.state }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'AccessList' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><LazyInterceptorAccessList
								goHome = { goHome }
								websiteAccess = { websiteAccess }
								websiteAccessAddressMetadata = { websiteAccessAddressMetadata }
								renameAddressCallBack = { renameAddressCallBack }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'ChangeActiveAddress' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><LazyChangeActiveAddress
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
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><LazyAddNewAddress
								setActiveAddressAndInformAboutIt = { setActiveAddressAndInformAboutIt }
								modifyAddressWindowState = { appPage.value.state }
								close = { goHome }
								activeAddress = { activeAddress.value }
								rpcEntries = { rpcEntries }
							/></ErrorBoundary>
						: <></> }
						{ appPage.value.page === 'ImportSimulation' ?
							<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }><LazyImportSimulationStack
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
