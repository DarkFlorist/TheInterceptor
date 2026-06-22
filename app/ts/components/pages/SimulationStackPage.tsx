import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { version, gitCommitSha } from '../../version.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EditEnsNamedHashWindowState, ModifyAddressWindowState, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { addressEditEntry } from '../ui-utils.js'
import { ErrorBoundary, ErrorComponent, UnexpectedError } from '../subcomponents/Error.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { BroomIcon, ImportIcon } from '../subcomponents/icons.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { TransactionsAndSignedMessages } from '../simulationExplaining/Transactions.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { SimulationStackCompactSummary } from '../simulationExplaining/SimulationStackCompactSummary.js'
import { AddNewAddress } from './AddNewAddress.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { ImportSimulationStack } from './ImportSimulationStack.js'
import { NetworkErrors } from '../subcomponents/NetworkErrors.js'
import { useLiveSimulationHomeData } from '../hooks/useLiveSimulationHomeData.js'

type ModalState =
	{ page: 'modifyAddress', state: Signal<ModifyAddressWindowState> } |
	{ page: 'editEnsNamedHash', state: EditEnsNamedHashWindowState } |
	{ page: 'importSimulation', state: Signal<string> } |
	{ page: 'noModal' }

function isEmptySimulation(simulationAndVisualisationResults: SimulationAndVisualisationResults) {
	return !simulationAndVisualisationResults.simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
}

function SimulationStackToolbar({ openImportSimulation, resetSimulation, disableReset }: {
	openImportSimulation: () => void
	resetSimulation: () => void
	disableReset: Signal<boolean>
}) {
	return <div style = 'display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1rem 0;'>
		<h1 class = 'h1' style = 'margin: 0;'>Simulation Stack</h1>
		<div style = 'display: flex; gap: 0.75rem; align-items: center;'>
			<button class = 'btn btn--outline is-small' onClick = { openImportSimulation }>
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<ImportIcon/>
				</span>
				<span>Import Simulation Stack</span>
			</button>
			<button class = 'btn is-small is-danger' disabled = { disableReset.value } onClick = { resetSimulation } >
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<BroomIcon />
				</span>
				<span>Clear</span>
			</button>
		</div>
	</div>
}

export function SimulationStackPage() {
	const {
		activeSimulationAddress,
		simVisResults,
		rpcNetwork,
		isSettingsLoaded,
		currentBlockNumber,
		rpcConnectionStatus,
		rpcEntries,
		simulationUpdatingState,
		simulationResultState,
		unexpectedError,
		numberOfAddressesMadeRich,
	} = useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: true,
		filterByTabId: false,
	})
	const disableReset = useSignal<boolean>(false)
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const boundaryResetKey = useSignal(0)
	const addressMetaData = useComputed(() => simVisResults.value.kind === 'simulated' ? simVisResults.value.value.addressBookEntries : [])
	const isEmpty = useComputed(() => {
		if (numberOfAddressesMadeRich.value > 0) return false
		if (simVisResults.value.kind === 'passthrough') return true
		return isEmptySimulation(simVisResults.value.value)
	})

	useSignalEffect(() => {
		simVisResults.value
		disableReset.value = false
	})

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = { page: 'modifyAddress', state: new Signal(addressEditEntry(entry)) }
	}

	function editEnsNamedHashCallBack(type: 'nameHash' | 'labelHash', nameHash: bigint, name: string | undefined) {
		modalState.value = { page: 'editEnsNamedHash', state: { type, nameHash, name } }
	}

	async function removeTransactionOrSignedMessage(transactionOrMessageIdentifier: TransactionOrMessageIdentifier) {
		await sendPopupMessageToBackgroundPage({ method: 'popup_removeTransactionOrSignedMessage', data: transactionOrMessageIdentifier })
	}

	function resetSimulation() {
		disableReset.value = true
		sendPopupMessageToBackgroundPage({ method: 'popup_resetSimulation' })
	}

	function onRenderError(error: Error) {
		unexpectedError.value = { method: 'popup_UnexpectedErrorOccured', data: { message: error.message, timestamp: new Date(), source: 'simulationStack', code: 'render_error', debugId: undefined } }
	}

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		boundaryResetKey.value += 1
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}

	const currentResults = simVisResults.value

	return <main style = 'background-color: var(--bg-color); min-height: 100vh;'>
		<div style = 'max-width: 1100px; margin: 0 auto; padding: 0 1rem 2rem;'>
			<nav class = 'navbar window-header' role = 'navigation' aria-label = 'main navigation' style = 'margin: 0 -1rem 1rem;'>
				<div class = 'navbar-brand'>
					<a class = 'navbar-item' style = 'cursor: unset'>
						<img src = '../img/LOGOA.svg' alt = 'Logo' width = '32' height = '32'/>
						<p style = 'color: var(--text-color); padding-left: 5px;'>THE INTERCEPTOR
							<span style = 'color: var(--unimportant-text-color); font-size: 0.8em; padding-left: 5px;' > { `${ version } - ${ gitCommitSha.slice(0, 8) }`  } </span>
						</p>
					</a>
				</div>
			</nav>
			<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value === undefined ? undefined : unexpectedError.value.data }/>
			<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
			{ rpcNetwork.value?.httpsRpc === undefined && rpcNetwork.value !== undefined ?
				<ErrorComponent text = { `${ rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ rpcNetwork.value.name }.` }/>
			: <></> }
			{ !isSettingsLoaded.value ? <CenterToPageTextSpinner/> : <ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }>
				<SimulationStackToolbar
					openImportSimulation = { () => { modalState.value = { page: 'importSimulation', state: new Signal('') } } }
					resetSimulation = { resetSimulation }
					disableReset = { disableReset }
				/>
				{ isEmpty.value ?
					<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
				: currentResults.kind === 'passthrough' ?
					<SimulationStackCompactSummary
						simulationAndVisualisationResults = { simVisResults }
						numberOfAddressesMadeRich = { numberOfAddressesMadeRich }
					/>
				: <div class = { simulationResultState.value === 'invalid' || simulationUpdatingState.value === 'failed' ? 'blur' : '' }>
					{ currentResults.value.visualizedSimulationState.success === false ?
						<ErrorComponent text = { `Failed to simulate the stack due to error: "${ currentResults.value.visualizedSimulationState.jsonRpcError.error.message }". Please modify the stack to make it simutable.` }/>
					: <></> }
					<SimulationStackCompactSummary
						simulationAndVisualisationResults = { simVisResults }
						numberOfAddressesMadeRich = { numberOfAddressesMadeRich }
					/>
					<TransactionsAndSignedMessages
						simulationAndVisualisationResults = { simVisResults }
						removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
						activeAddress = { activeSimulationAddress }
						renameAddressCallBack = { renameAddressCallBack }
						editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
						addressMetaData = { addressMetaData }
					/>
					<SimulationSummary
						simulationAndVisualisationResults = { simVisResults }
						currentBlockNumber = { currentBlockNumber }
						activeAddress = { activeSimulationAddress }
						renameAddressCallBack = { renameAddressCallBack }
						rpcConnectionStatus = { rpcConnectionStatus }
					/>
				</div> }
			</ErrorBoundary> }
		</div>
		<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
			{ modalState.value.page === 'modifyAddress' ?
				<AddNewAddress
					setActiveAddressAndInformAboutIt = { undefined }
					modifyAddressWindowState = { modalState.value.state }
					close = { () => { modalState.value = { page: 'noModal' } } }
					activeAddress = { activeSimulationAddress.value }
					rpcEntries = { rpcEntries }
				/>
			: <></> }
			{ modalState.value.page === 'editEnsNamedHash' ?
				<EditEnsLabelHash
					close = { () => { modalState.value = { page: 'noModal' } } }
					editEnsNamedHashWindowState = { modalState.value.state }
				/>
			: <></> }
			{ modalState.value.page === 'importSimulation' ?
				<ImportSimulationStack
					close = { () => { modalState.value = { page: 'noModal' } } }
					simulationInput = { modalState.value.state }
				/>
			: <></> }
		</div>
	</main>
}
