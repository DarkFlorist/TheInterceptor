import { useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ModifyAddressWindowState, EditEnsNamedHashWindowState } from '../types/visualizer-types.js'
import { Home } from './pages/Home.js'
import Hint from './subcomponents/Hint.js'
import { getAddress, isAddress } from '../utils/viem.js'
import { PasteCatcher } from './subcomponents/PasteCatcher.js'
import { truncateAddr } from '../utils/ethereum.js'
import type { Settings } from '../types/interceptor-messages.js'
import { version, gitCommitSha } from '../version.js'
import { sendPopupMessageToBackgroundPage } from '../background/backgroundUtils.js'
import type { EthereumBytes32 } from '../types/wire-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcEntry } from '../types/rpc.js'
import { ErrorBoundary, UnexpectedError } from './subcomponents/Error.js'
import { addressEditEntry } from './ui-utils.js'
import { Signal, useComputed, useSignal } from '@preact/signals'
import { CenterToPageTextSpinner } from './subcomponents/Spinner.js'
import { POPUP_PERFORMANCE_MARKS, markPerformanceOnce } from '../utils/popupPerformance.js'
import type { AddAddressParam, ChangeActiveAddressParam, InterceptorAccessListParams } from '../types/user-interface-types.js'
import { createUnexpectedErrorPopupMessage } from '../utils/unexpectedErrorPopupMessage.js'
import { useLiveSimulationHomeData } from './hooks/useLiveSimulationHomeData.js'
import { NetworkErrors } from './subcomponents/NetworkErrors.js'
import { ProviderErrors } from './subcomponents/ProviderErrors.js'
export { NetworkErrors } from './subcomponents/NetworkErrors.js'

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
	const {
		activeAddresses,
		activeSimulationAddress,
		activeSigningAddress,
		useSignersAddressAsActiveAddress,
		simVisResults,
		websiteAccess,
		websiteAccessAddressMetadata,
		rpcNetwork,
		tabIconDetails,
		isSettingsLoaded,
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
	} = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: true,
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

	async function setActiveAddressAndInformAboutIt(address: bigint | 'signer') {
		if (!isSettingsLoaded.value) return
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

	const activeAddress = useComputed(() => simulationMode.value ? activeSimulationAddress.value : activeSigningAddress.value)

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
						numberOfAddressesMadeRich = { numberOfAddressesMadeRich }
						isInitialHomeDataLoaded = { isSettingsLoaded }
					/>

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
