import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { requestPopupInterceptorSimulationInput, sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EditEnsNamedHashWindowState, ModifyAddressWindowState, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { addressEditEntry } from '../ui-utils.js'
import { ErrorBoundary, ErrorComponent, UnexpectedError } from '../subcomponents/Error.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { BroomIcon, ExportIcon, ImportIcon } from '../subcomponents/icons.js'
import { clipboardCopy } from '../subcomponents/clipboardcopy.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { TransactionsAndSignedMessages } from '../simulationExplaining/Transactions.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { AddNewAddress } from './AddNewAddress.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { ImportSimulationStack } from './ImportSimulationStack.js'
import { NetworkErrors } from '../subcomponents/NetworkErrors.js'
import { useLiveSimulationHomeData } from '../hooks/useLiveSimulationHomeData.js'
import { useResetSimulation } from '../hooks/useResetSimulation.js'
import { useEffect } from 'preact/hooks'
import { getSimulationStackTargetElementIdFromHash } from '../../utils/simulationStackTargets.js'

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
	const exportSimulationStack = async () => {
		const reply = await requestPopupInterceptorSimulationInput()
		if (reply === undefined) return
		await clipboardCopy(reply.ethSimulateV1InputString)
	}
	return <header class = 'simulation-stack-page-header'>
		<div class = 'simulation-stack-page-title'>
			<h1>Simulation Stack</h1>
			<p>Import, export, and adjust the simulation stack.</p>
		</div>
		<div class = 'simulation-stack-page-actions'>
			<button class = 'btn btn--outline is-small' type = 'button' onClick = { openImportSimulation } title = 'Import simulation stack' aria-label = 'Import simulation stack'>
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<ImportIcon/>
				</span>
				<span>Import</span>
			</button>
			<button
				class = 'btn btn--outline is-small'
				type = 'button'
				onClick = { exportSimulationStack }
				title = 'Export simulation stack'
				aria-label = 'Export simulation stack'
				data-hint-clickable-hide-timer-ms = { 1500 }
				data-hint = 'Interceptor Simulation input copied!'
			>
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<ExportIcon/>
				</span>
				<span>Export</span>
			</button>
			<button class = 'btn btn--destructive is-small' type = 'button' disabled = { disableReset.value } onClick = { resetSimulation } title = 'Clear simulation stack' aria-label = 'Clear simulation stack'>
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<BroomIcon />
				</span>
				<span>Clear</span>
			</button>
		</div>
	</header>
}

function RichAddressesTitleCard({ numberOfAddressesMadeRich }: { numberOfAddressesMadeRich: number }) {
	if (numberOfAddressesMadeRich === 0) return <></>
	return <section class = 'card' style = 'margin: 10px 0;'>
		<header class = 'card-header stack-card-header'>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon'>
					<img src = '../img/success-icon.svg' width = '24' height = '24' />
				</span>
			</div>
			<p class = 'card-header-title' style = 'white-space: nowrap;'>
				Simply making { numberOfAddressesMadeRich } { numberOfAddressesMadeRich === 1 ? 'address' : 'addresses' } rich
			</p>
		</header>
	</section>
}

function scheduleStackTargetFrame(callback: () => void) {
	if (typeof globalThis.requestAnimationFrame === 'function') {
		globalThis.requestAnimationFrame(callback)
		return
	}
	if (typeof globalThis.setTimeout === 'function') {
		globalThis.setTimeout(callback, 0)
		return
	}
	callback()
}

function scheduleStackTargetTimeout(callback: () => void, delayMs: number) {
	if (typeof globalThis.setTimeout === 'function') {
		globalThis.setTimeout(callback, delayMs)
		return
	}
	callback()
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
		requireActiveSimulationAddress: false,
	})
	const { disableReset, resetSimulation, markSimulationDataReceived } = useResetSimulation()
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const boundaryResetKey = useSignal(0)
	const highlightedStackTargetId = useSignal<string | undefined>(undefined)
	const handledStackTargetHash = useSignal<string | undefined>(undefined)
	const addressMetaData = useComputed(() => simVisResults.value.kind === 'simulated' ? simVisResults.value.value.addressBookEntries : [])
	const isEmpty = useComputed(() => {
		if (numberOfAddressesMadeRich.value > 0) return false
		if (simVisResults.value.kind === 'passthrough') return true
		return isEmptySimulation(simVisResults.value.value)
	})

	useSignalEffect(() => {
		simVisResults.value
		markSimulationDataReceived()
	})

	const scrollToRequestedStackRow = () => {
		const browserWindow = globalThis.window
		const browserDocument = globalThis.document
		if (browserWindow === undefined || browserDocument === undefined) return
		const targetHash = browserWindow.location?.hash
		if (targetHash === undefined) return
		if (handledStackTargetHash.value === targetHash) return
		const targetElementId = getSimulationStackTargetElementIdFromHash(targetHash)
		if (targetElementId === undefined) return
		if (typeof browserDocument.getElementById !== 'function') return
		const targetElement = browserDocument.getElementById(targetElementId)
		if (targetElement === null) return
		if (typeof targetElement.scrollIntoView !== 'function') return
		targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
		handledStackTargetHash.value = targetHash
		highlightedStackTargetId.value = targetElementId
		scheduleStackTargetTimeout(() => {
			if (highlightedStackTargetId.value === targetElementId) highlightedStackTargetId.value = undefined
		}, 1800)
	}

	useEffect(() => {
		const scrollOnHashChange = () => {
			handledStackTargetHash.value = undefined
			scrollToRequestedStackRow()
		}
		const browserWindow = globalThis.window
		if (browserWindow === undefined || typeof browserWindow.addEventListener !== 'function' || typeof browserWindow.removeEventListener !== 'function') {
			scheduleStackTargetFrame(scrollOnHashChange)
			return undefined
		}
		browserWindow.addEventListener('hashchange', scrollOnHashChange)
		scheduleStackTargetFrame(scrollOnHashChange)
		return () => browserWindow.removeEventListener('hashchange', scrollOnHashChange)
	}, [])

	useSignalEffect(() => {
		simVisResults.value
		scheduleStackTargetFrame(scrollToRequestedStackRow)
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

	function onRenderError(error: Error) {
		unexpectedError.value = { method: 'popup_UnexpectedErrorOccured', data: { message: error.message, timestamp: new Date(), source: 'simulationStack', code: 'render_error', debugId: undefined } }
	}

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		boundaryResetKey.value += 1
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}

	const currentResults = simVisResults.value

	return <main>
		<div class = 'layout simulation-stack-page'>
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
					<article class = 'simulation-stack-page-content'><DinoSays text = { 'Give me some transactions to munch on!' } /></article>
				: currentResults.kind === 'passthrough' ?
					<article class = 'simulation-stack-page-content'><RichAddressesTitleCard numberOfAddressesMadeRich = { numberOfAddressesMadeRich.value } /></article>
				: <article class = { `simulation-stack-page-content${ simulationResultState.value === 'invalid' || simulationUpdatingState.value === 'failed' ? ' blur' : '' }` }>
					{ currentResults.value.visualizedSimulationState.success === false ?
						<ErrorComponent text = { `Failed to simulate the stack due to error: "${ currentResults.value.visualizedSimulationState.jsonRpcError.error.message }". Please modify the stack to make it simutable.` }/>
					: <></> }
					<RichAddressesTitleCard numberOfAddressesMadeRich = { numberOfAddressesMadeRich.value } />
					<TransactionsAndSignedMessages
						simulationAndVisualisationResults = { simVisResults }
						removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
						activeAddress = { activeSimulationAddress }
						renameAddressCallBack = { renameAddressCallBack }
						editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
						addressMetaData = { addressMetaData }
						highlightedStackTargetId = { highlightedStackTargetId }
					/>
					<SimulationSummary
						simulationAndVisualisationResults = { simVisResults }
						currentBlockNumber = { currentBlockNumber }
						activeAddress = { activeSimulationAddress }
						renameAddressCallBack = { renameAddressCallBack }
						rpcConnectionStatus = { rpcConnectionStatus }
					/>
				</article> }
			</ErrorBoundary> }
		</div>
		<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
			{ modalState.value.page === 'modifyAddress' ?
				<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }>
					<AddNewAddress
						setActiveAddressAndInformAboutIt = { undefined }
						modifyAddressWindowState = { modalState.value.state }
						close = { () => { modalState.value = { page: 'noModal' } } }
						activeAddress = { activeSimulationAddress.value }
						rpcEntries = { rpcEntries }
					/>
				</ErrorBoundary>
			: <></> }
			{ modalState.value.page === 'editEnsNamedHash' ?
				<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }>
					<EditEnsLabelHash
						close = { () => { modalState.value = { page: 'noModal' } } }
						editEnsNamedHashWindowState = { modalState.value.state }
					/>
				</ErrorBoundary>
			: <></> }
			{ modalState.value.page === 'importSimulation' ?
				<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }>
					<ImportSimulationStack
						close = { () => { modalState.value = { page: 'noModal' } } }
						simulationInput = { modalState.value.state }
					/>
				</ErrorBoundary>
			: <></> }
		</div>
	</main>
}
