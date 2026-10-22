import { useEffect } from 'preact/hooks'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { requestPopupCompleteVisualizedSimulation, requestPopupSimulationMetadata, sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { addressEditEntry, tryFocusingTabOrWindow } from '../ui-utils.js'
import type { PendingFetchSimulationStackRequestPromise } from '../../types/user-interface-types.js'
import { type ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { type EditEnsNamedHashWindowState, type ModifyAddressWindowState, type SimulationAndVisualisationResults, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { SmallAddress } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import Hint from '../subcomponents/Hint.js'
import type { RpcEntries } from '../../types/rpc.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { SimulationStackRows } from '../simulationExplaining/Transactions.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { type ShownSimulationStack, type SimulationStackUpdate, applySimulationStackUpdate } from './fetchSimulationStackUpdates.js'
import { subscribeToSimulationStatePublications } from '../simulationStatePublications.js'
import type { EthereumBytes32 } from '../../types/wire-types.js'

export type FetchSimulationStackModalState =
	{ page: 'modifyAddress', state: Signal<ModifyAddressWindowState> } |
	{ page: 'editEnsNamedHash', state: EditEnsNamedHashWindowState } |
	{ page: 'noModal' }

export function FetchSimulationStackModal({ modalState, rpcEntries }: {
	modalState: Signal<FetchSimulationStackModalState>
	rpcEntries: Signal<RpcEntries>
}) {
	const close = () => {
		modalState.value = { page: 'noModal' }
	}
	return <div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : '' }` }>
		{ modalState.value.page === 'modifyAddress' ?
			<AddNewAddress
				setActiveAddressAndInformAboutIt = { undefined }
				modifyAddressWindowState = { modalState.value.state }
				close = { close }
				activeAddress = { undefined }
				rpcEntries = { rpcEntries }
			/>
		: <></> }
		{ modalState.value.page === 'editEnsNamedHash' ?
			<EditEnsLabelHash
				close = { close }
				editEnsNamedHashWindowState = { modalState.value.state }
			/>
		: <></> }
	</div>
}

export function FetchSimulationStackRows({
	simulationAndVisualisationResults,
	activeAddress,
	addressMetaData,
	renameAddressCallBack,
	modalState,
}: {
	simulationAndVisualisationResults: ReadonlySignal<SimulationAndVisualisationResults | undefined>
	activeAddress: ReadonlySignal<bigint | undefined>
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
	renameAddressCallBack: (entry: AddressBookEntry) => void
	modalState: Signal<FetchSimulationStackModalState>
}) {
	const editEnsNamedHashCallBack = (type: 'nameHash' | 'labelHash', nameHash: EthereumBytes32, name: string | undefined) => {
		modalState.value = { page: 'editEnsNamedHash', state: { type, nameHash, name } }
	}
	return <SimulationStackRows
		simulationAndVisualisationResults = { simulationAndVisualisationResults }
		removeTransactionOrSignedMessage = { undefined }
		activeAddress = { activeAddress }
		renameAddressCallBack = { renameAddressCallBack }
		editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
		addressMetaData = { addressMetaData }
		showTimePicker = { false }
	/>
}

export function FetchSimulationStack() {
	const changeRequest = useSignal<PendingFetchSimulationStackRequestPromise | undefined>(undefined)
	const modalState = useSignal<FetchSimulationStackModalState>({ page: 'noModal' })

	const shownSimulationStack = useSignal<ShownSimulationStack>({ visualisation: createPassthroughCompleteVisualizedSimulation(), addressBookEntries: undefined })
	const rpcEntries = useSignal<RpcEntries>([])
	const { value: rejectRequestState, waitFor: waitForRejectRequest } = useAsyncState<void>()
	const { value: allowRequestState, waitFor: waitForAllowRequest } = useAsyncState<void>()

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = { page: 'modifyAddress', state: new Signal(addressEditEntry(entry)) }
	}

	useEffect(() => {
		function popupMessageListener(msg: unknown): false {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_requestSettingsReply') {
				rpcEntries.value = parsed.data.rpcEntries
				return false
			}
			if (parsed.method !== 'popup_fetchSimulationStackRequest') return false
			changeRequest.value = parsed.data
			return false
		}
		return noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
	}, [])

	// The only writer of the shown stack: publications and the opening replies arrive in any order, and applySimulationStackUpdate decides what each may replace.
	const applyUpdate = (update: SimulationStackUpdate) => {
		shownSimulationStack.value = applySimulationStackUpdate(shownSimulationStack.peek(), update)
	}
	useEffect(() => subscribeToSimulationStatePublications((visualisation) => applyUpdate({ source: 'publication', visualisation })), [])
	const requestOpeningVisualisation = async () => {
		const reply = await requestPopupCompleteVisualizedSimulation()
		if (reply !== undefined) applyUpdate({ source: 'openingVisualisationReply', visualisation: reply.visualizedSimulatorState })
	}
	// Without an open home popup or simulation stack page the stored visualisation is not refreshed, so in simulation mode opening this page simulates the current stack once for its address references.
	const requestOpeningMetadata = async () => {
		const reply = await requestPopupSimulationMetadata()
		if (reply !== undefined) applyUpdate({ source: 'openingMetadataReply', addressBookEntries: reply.metadata.addressBookEntries })
	}

	useEffect(() => {
		void sendPopupReadyAndListening('fetchSimulationStack')
		requestOpeningVisualisation()
		requestOpeningMetadata()
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

	const allowRequest = () => {
		void waitForAllowRequest(() => approve())
	}
	const rejectPending = rejectRequestState.value.state === 'pending'
	const allowPending = allowRequestState.value.state === 'pending'
	const rejectRequest = () => {
		void waitForRejectRequest(() => reject())
	}

	const simulationStackResults = useComputed<SimulationAndVisualisationResults | undefined>(() => {
		const complete = shownSimulationStack.value.visualisation
		if (complete.simulationState.kind === 'passthrough') return undefined
		return {
			blockNumber: complete.simulationState.value.blockNumber,
			blockTimestamp: complete.simulationState.value.blockTimestamp,
			simulationConductedTimestamp: complete.simulationState.value.simulationConductedTimestamp,
			simulationStateInput: complete.simulationState.value.simulationStateInput,
			addressBookEntries: complete.addressBookEntries,
			visualizedSimulationState: complete.visualizedSimulationState,
			rpcNetwork: complete.simulationState.value.rpcNetwork,
			tokenPriceEstimates: complete.tokenPriceEstimates,
			namedTokenIds: complete.namedTokenIds,
		}
	})

	const isThereSimulationStack = useComputed(() => {
		const stackResults = simulationStackResults.value
		if (stackResults === undefined) return false
		return stackResults.simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0) || shownSimulationStack.value.visualisation.numberOfAddressesMadeRich !== 0
	})

	const addressMetaData = useComputed(() => shownSimulationStack.value.addressBookEntries ?? [])
	const addressReferences = useComputed(() => addressMetaData.value.filter((address) => address.address !== ETHEREUM_LOGS_LOGGER_ADDRESS))
	const activeAddress = useSignal<bigint | undefined>(undefined)

	if (changeRequest.value === undefined || shownSimulationStack.value.addressBookEntries === undefined) return <main> <CenterToPageTextSpinner text = { 'Getting simulation stack...'  }/></main>
	const websiteIcon = sanitizeStoredWebsiteIcon(changeRequest.value.website.icon)
	return (
		<main>
			<Hint>
				<FetchSimulationStackModal modalState = { modalState } rpcEntries = { rpcEntries } />
				<div class = 'block' style = 'margin-bottom: 0px; margin: 10px'>
					<header class = 'card-header window-header'>
						<div class = 'card-header-icon unset-cursor'>
							<span class = 'icon'>
								<img src = '../img/access-key.svg' width = '24' height = '24'/>
							</span>
						</div>
						<div class = 'card-header-title'>
							<p class = 'paragraph'>
								Interceptor Simulation Stack Request
							</p>
						</div>
					</header>
					<div class = 'card-content'>
						<article class = 'media'>
							{
								websiteIcon === undefined
									? <></>
									: <figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
										<div class = 'image is-64x64'>
											<img src = { websiteIcon } width = '64' height = '64'/>
										</div>
									</figure>
							}
						</article>
						<div class = 'media-content' style = 'padding-bottom: 10px'>
							<div class = 'content'>
								<p class = 'title' style = 'white-space: normal; text-align: center; padding: 10px;'>
									<b>	{ changeRequest.value.website.websiteOrigin } </b>
									would like to retrieve your Simulation Stack
								</p>
								<div class = 'notification transaction-importance-box simulation-stack-view'>
									<div style = 'width: 100%;'>
										<p class = 'paragraph' style = { { minWidth: '400px' } }> Your simulation stack includes references to the following addresses. Sharing this information may allow the website to link these addresses together:</p>
										<div class = 'sub-importance-box'>
											{ addressReferences.value.length === 0 ? <p class = 'paragraph'> No address references</p> : <></> }
											<div style = { { display: 'flex', flexDirection: 'column', width: 'max-content', } } >
												{ addressReferences.value.map((addressBookEntry) => <SmallAddress key = { addressBookEntry.address.toString() } addressBookEntry = { addressBookEntry } renameAddressCallBack = { renameAddressCallBack }/> ) }
											</div>
										</div>
									</div>
									<div style = 'width: 100%;'>
										<p class = 'paragraph'> Simulation stack:</p>
										<div class = 'sub-importance-box'>
											{ !isThereSimulationStack.value ? <p class = 'paragraph'> No simulation stack</p> : <>
												<FetchSimulationStackRows
													simulationAndVisualisationResults = { simulationStackResults }
													activeAddress = { activeAddress }
													renameAddressCallBack = { renameAddressCallBack }
													addressMetaData = { addressMetaData }
													modalState = { modalState }
												/>
											</> }
										</div>
									</div>
								</div>
							</div>
						</div>
						<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
							<AsyncActionButton
								class = { 'button is-danger dialog-action-button' }
								state = { rejectRequestState.value.state }
								disabled = { allowPending }
								text = { 'Don' + '\u0027' + 't allow' }
								pendingText = 'Rejecting request...'
								onClick = { rejectRequest }
							/>
							<AsyncActionButton
								class = { 'button is-primary dialog-action-button' }
								state = { allowRequestState.value.state }
								disabled = { rejectPending }
								text = 'Allow'
								pendingText = 'Allowing request...'
								onClick = { allowRequest }
							/>
						</div>
					</div>
				</div>

				<div class = 'content' style = 'height: 0.1px'/>
			</Hint>
		</main>
	)
}
