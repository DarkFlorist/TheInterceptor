import { useEffect } from 'preact/hooks'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { addressEditEntry, tryFocusingTabOrWindow } from '../ui-utils.js'
import { PendingFetchSimulationStackRequestPromise } from '../../types/user-interface-types.js'
import { Signal, useComputed, useSignal } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { CompleteVisualizedSimulation, ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { TransactionNames } from './ConfirmTransaction.js'
import { PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { SmallAddress } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import Hint from '../subcomponents/Hint.js'
import { RpcEntries } from '../../types/rpc.js'
import { SimulationMetadata } from '../../types/interceptor-reply-messages.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'

type ModalState =
	{ page: 'modifyAddress', state: Signal<ModifyAddressWindowState> } |
	{ page: 'noModal' }

export function FetchSimulationStack() {
	const changeRequest = useSignal<PendingFetchSimulationStackRequestPromise | undefined>(undefined)
	const modalState = useSignal<ModalState>({ page: 'noModal' })

	const completeVisualizedSimulation = useSignal<CompleteVisualizedSimulation | undefined>(undefined)
	const currentPendingTransaction = useSignal<PendingTransactionOrSignableMessage | undefined>(undefined)
	const simulationMetadata = useSignal<SimulationMetadata | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = { page: 'modifyAddress', state: new Signal(addressEditEntry(entry)) }
	}

	useEffect(() => {
		function popupMessageListener(msg: unknown): false {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_simulation_state_changed') {
				updateSimulation()
				updateMetaData()
				return false
			}
			else if (parsed.method === 'popup_requestSettingsReply') {
				rpcEntries.value = parsed.data.rpcEntries
				return false
			}
			if (parsed.method !== 'popup_fetchSimulationStackRequest') return false
			changeRequest.value = parsed.data
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	const updateSimulation = async () => {
		const simulationStack = await sendPopupMessageWithReply({ method: 'popup_requestCompleteVisualizedSimulation' })
		if (simulationStack === undefined) return
		completeVisualizedSimulation.value = simulationStack.visualizedSimulatorState
	}
	const updateMetaData = async () => {
		const data = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMetadata' })
		if (data === undefined) return
		simulationMetadata.value = data.metadata
	}

	useEffect(() => {
		sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestReadyAndListening' })
		updateSimulation()
		updateMetaData()
		sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
	}, [])

	async function approve() {
		if (changeRequest.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: changeRequest.value.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestConfirmation', data: { accept: true, uniqueRequestIdentifier: changeRequest.value.uniqueRequestIdentifier, simulationStackVersion: changeRequest.value?.simulationStackVersion } })
	}

	async function reject() {
		if (changeRequest.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: changeRequest.value.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestConfirmation', data: { accept: false, uniqueRequestIdentifier: changeRequest.value.uniqueRequestIdentifier, simulationStackVersion: changeRequest.value?.simulationStackVersion } })
	}

	const isThereSimulationStack = useComputed(() => {
		if (completeVisualizedSimulation.value === undefined) return false
		if (completeVisualizedSimulation.value.visualizedSimulationState.success === false) return false
		return completeVisualizedSimulation.value.numberOfAddressesMadeRich || completeVisualizedSimulation.value.visualizedSimulationState.visualizedBlocks.length > 0
	})

	const addressReferences = useComputed(() => {
		if (simulationMetadata.value === undefined) return []
		return simulationMetadata.value.addressBookEntries.filter((address) => address.address !== ETHEREUM_LOGS_LOGGER_ADDRESS)
	})

	if (changeRequest.value === undefined || simulationMetadata.value === undefined || completeVisualizedSimulation.value === undefined) return <main> <CenterToPageTextSpinner text = { 'Getting simulation stack...'  }/></main>
	return (
		<main>
			<Hint>
				<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
					{ modalState.value.page === 'modifyAddress' ?
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							modifyAddressWindowState = { modalState.value.state }
							close = { () => { modalState.value = { page: 'noModal' } } }
							activeAddress = { undefined }
							rpcEntries = { rpcEntries }
						/>
					: <></> }
				</div>
				<div className = 'block' style = 'margin-bottom: 0px; margin: 10px'>
					<header class = 'card-header window-header'>
						<div class = 'card-header-icon unset-cursor'>
							<span class = 'icon'>
								<img src = '../img/access-key.svg'/>
							</span>
						</div>
						<div class = 'card-header-title'>
							<p className = 'paragraph'>
								Interceptor Simulation Stack Request
							</p>
						</div>
					</header>
					<div class = 'card-content'>
						<article class = 'media'>
							{
								changeRequest.value.website.icon === undefined
									? <></>
									: <figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
										<div class = 'image is-64x64'>
											<img src = { changeRequest.value.website.icon }/>
										</div>
									</figure>
							}
						</article>
						<div class = 'media-content' style = 'padding-bottom: 10px'>
							<div class = 'content'>
								<p className = 'title' style = 'white-space: normal; text-align: center; padding: 10px;'>
									<b>	{ changeRequest.value.website.websiteOrigin } </b>
									would like to retrieve your Simulation Stack
								</p>
								<div class = 'notification transaction-importance-box simulation-stack-view'>
									<div style = 'width: 100%;'>
										<p class = 'paragraph' style = { { minWidth: '400px' } }> Your simulation stack includes references to the following addresses. Sharing this information may allow the website to link these addresses together:</p>
										<div class = 'sub-importance-box'>
											{ addressReferences.value.length === 0 ? <p class = 'paragraph'> No address references</p> : <></> }
											<div style = { { display: 'flex', flexDirection: 'column', width: 'max-content', } } >
												{ addressReferences.value.map((addressBookEntry) => <SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { renameAddressCallBack }/> ) }
											</div>
										</div>
									</div>
									<div style = 'width: 100%;'>
										<p class = 'paragraph'> Simulation stack:</p>
										<div class = 'sub-importance-box'>
											{ !isThereSimulationStack.value ? <p class = 'paragraph'> No simulation stack</p> : <>
												<TransactionNames
													completeVisualizedSimulation = { completeVisualizedSimulation }
													currentPendingTransaction = { currentPendingTransaction }
													includeCurrentTransaction = { false }
												/>
											</> }
										</div>
									</div>
								</div>
							</div>
						</div>
						<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
							<button
								className = { 'button is-danger' }
								style = { 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' }
								onClick = { reject } >
								Don't allow
							</button>
							<button
								className = { 'button is-primary' }
								disabled = { false }
								style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
								onClick = { approve }>
								Allow
							</button>
						</div>
					</div>
				</div>

				<div class = 'content' style = 'height: 0.1px'/>
			</Hint>
		</main>
	)
}
