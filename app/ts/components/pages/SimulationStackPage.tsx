import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { requestPopupInterceptorSimulationInput, sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EditEnsNamedHashWindowState, ModifyAddressWindowState, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { addressEditEntry } from '../ui-utils.js'
import { ErrorBoundary, ErrorComponent, UnexpectedError } from '../subcomponents/Error.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { BroomIcon, ChevronIcon, ExportIcon, ImportIcon } from '../subcomponents/icons.js'
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
import { SmallAddress, getActiveAddressEntry } from '../subcomponents/address.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import { createUnexpectedErrorPopupMessage } from '../../utils/unexpectedErrorPopupMessage.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'

type ModalState =
	{ page: 'modifyAddress', state: Signal<ModifyAddressWindowState> } |
	{ page: 'editEnsNamedHash', state: EditEnsNamedHashWindowState } |
	{ page: 'importSimulation', state: Signal<string> } |
	{ page: 'noModal' }

function isEmptySimulation(simulationAndVisualisationResults: SimulationAndVisualisationResults) {
	return !simulationAndVisualisationResults.simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
}

function getMadeRichAddressBookEntries(
	richList: readonly EnrichedRichListElement[],
	makeCurrentAddressRich: boolean,
	activeSimulationAddress: bigint | undefined,
	activeAddresses: AddressBookEntries,
) {
	const entries = richList.filter((element) => element.makingRich).map((element) => element.addressBookEntry)
	if (!makeCurrentAddressRich || activeSimulationAddress === undefined || entries.some((entry) => entry.address === activeSimulationAddress)) return entries
	return [...entries, getActiveAddressEntry(activeSimulationAddress, activeAddresses)]
}

function SimulationStackToolbar({ openImportSimulation, resetSimulation, disableReset }: {
	openImportSimulation: () => void
	resetSimulation: () => void
	disableReset: Signal<boolean>
}) {
	const { value: exportSimulationStackState, waitFor: waitForExportSimulationStack } = useAsyncState<void>()
	const { value: clearSimulationStackState, waitFor: waitForClearSimulationStack } = useAsyncState<void>()

	const exportSimulationStack = async () => {
		const reply = await requestPopupInterceptorSimulationInput()
		if (reply === undefined) return
		await clipboardCopy(reply.ethSimulateV1InputString)
	}

	const exportStack = () => {
		void waitForExportSimulationStack(exportSimulationStack)
	}

	const clearStack = () => {
		void waitForClearSimulationStack(async () => {
			resetSimulation()
		})
	}

	return <header class = 'simulation-stack-page-header'>
		<div class = 'simulation-stack-page-title'>
			<h1>Simulation Stack</h1>
			<p>Import, export, and adjust the simulation stack.</p>
		</div>
		<div class = 'simulation-stack-page-actions'>
			<button class = 'btn btn--outline' type = 'button' onClick = { openImportSimulation } title = 'Import simulation stack' aria-label = 'Import simulation stack'>
				<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
					<ImportIcon/>
				</span>
				<span>Import</span>
			</button>
			<AsyncActionButton
				class = 'btn btn--outline'
				type = 'button'
				state = { exportSimulationStackState.value.state }
				onClick = { exportStack }
				text = { <>
					<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
						<ExportIcon/>
					</span>
					<span>Export</span>
				</> }
				pendingText = 'Exporting simulation stack...'
			/>
			<AsyncActionButton
				class = 'btn btn--destructive'
				type = 'button'
				state = { clearSimulationStackState.value.state }
				disabled = { disableReset.value }
				onClick = { clearStack }
				text = { <>
					<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
						<BroomIcon />
					</span>
					<span>Clear</span>
				</> }
				pendingText = 'Clearing simulation stack...'
			/>
		</div>
	</header>
}

function RichAddressesTitleCard({ numberOfAddressesMadeRich, madeRichAddressBookEntries, renameAddressCallBack }: {
	numberOfAddressesMadeRich: number
	madeRichAddressBookEntries: readonly AddressBookEntry[]
	renameAddressCallBack: (entry: AddressBookEntry) => void
}) {
	const collapsed = useSignal(false)
	if (numberOfAddressesMadeRich === 0) return <></>
	const headerActionLabel = collapsed.value ? 'Expand rich address details' : 'Collapse rich address details'
	const richAddressesSentence = getRichAddressesSentence(madeRichAddressBookEntries)
	const richAddressesIntro = getRichAddressesIntro(madeRichAddressBookEntries.length)
	return <section class = 'card' style = 'margin: 10px 0;'>
		<header
			class = 'card-header stack-card-header stack-row-link-header'
			onClick = { () => { collapsed.value = !collapsed.value } }
			onKeyDown = { (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return
				if (event.target !== event.currentTarget) return
				event.preventDefault()
				collapsed.value = !collapsed.value
			} }
			role = 'button'
			tabIndex = { 0 }
			title = { headerActionLabel }
			aria-label = { headerActionLabel }
			aria-expanded = { !collapsed.value }
		>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon'>
					<img src = '../img/success-icon.svg' width = '24' height = '24' />
				</span>
			</div>
			<p class = 'card-header-title' style = 'white-space: nowrap;'>
				Simply making { numberOfAddressesMadeRich } { numberOfAddressesMadeRich === 1 ? 'address' : 'addresses' } rich
			</p>
			<div class = 'card-header-icon noselect'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ collapsed.value ? <></> : <div class = 'card-content' style = 'padding-bottom: 5px;'>
			<div class = 'container'>
				<p class = 'paragraph checkbox-text' style = { { marginBottom: 0 } } aria-label = { richAddressesSentence }>
					<span>{ richAddressesIntro } </span>
					{ madeRichAddressBookEntries.map((entry, index) =>
						<span key = { entry.address.toString() } class = 'rich-address-sentence-group' style = 'white-space: nowrap;'>
							<RichAddressPrefix index = { index } total = { madeRichAddressBookEntries.length } />
							<SmallAddress addressBookEntry = { entry } renameAddressCallBack = { renameAddressCallBack } />
							<RichAddressSuffix index = { index } total = { madeRichAddressBookEntries.length } />
						</span>
					) }
					<span>.</span>
				</p>
			</div>
		</div> }
	</section>
}

function getRichAddressesIntro(numberOfAddresses: number) {
	return numberOfAddresses === 1 ? 'Address being made rich is' : 'Addresses being made rich are'
}

function getRichAddressesSentence(madeRichAddressBookEntries: readonly AddressBookEntry[]) {
	const names = madeRichAddressBookEntries.map((entry) => entry.name)
	if (names.length === 0) return 'Addresses being made rich are.'
	if (names.length === 1) return `Address being made rich is ${ names[0] }.`
	const finalName = names[names.length - 1]
	const previousNames = names.slice(0, -1)
	return `Addresses being made rich are ${ previousNames.join(', ') } and ${ finalName }.`
}

function RichAddressPrefix({ index, total }: { index: number, total: number }) {
	if (index === 0) return <></>
	if (index === total - 1) return <span> and </span>
	return <span> </span>
}

function RichAddressSuffix({ index, total }: { index: number, total: number }) {
	if (index < total - 2) return <span>,</span>
	return <></>
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
		activeAddresses,
		simVisResults,
		rpcNetwork,
		isSettingsLoaded,
		currentBlockNumber,
		rpcConnectionStatus,
		rpcEntries,
		simulationUpdatingState,
		simulationResultState,
		unexpectedError,
		fixedAddressRichList,
		makeCurrentAddressRich,
		numberOfAddressesMadeRich,
	} = useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: true,
		filterByTabId: false,
		requireActiveSimulationAddress: false,
		requestHomeDataOnSimulationStateChange: true,
	})
	const { disableReset, resetSimulation, markSimulationDataReceived } = useResetSimulation()
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const boundaryResetKey = useSignal(0)
	const highlightedStackTargetId = useSignal<string | undefined>(undefined)
	const handledStackTargetHash = useSignal<string | undefined>(undefined)
	const addressMetaData = useComputed(() => simVisResults.value.kind === 'simulated' ? simVisResults.value.value.addressBookEntries : [])
	const madeRichAddressBookEntries = useComputed(() => getMadeRichAddressBookEntries(
		fixedAddressRichList.value,
		makeCurrentAddressRich.value,
		activeSimulationAddress.value,
		activeAddresses.value,
	))
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
		unexpectedError.value = createUnexpectedErrorPopupMessage({
			timestamp: new Date(),
			message: error.message,
			source: 'simulationStack',
			code: 'render_error',
			debugId: undefined,
		})
	}

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		boundaryResetKey.value += 1
		await sendPopupMessageToBackgroundPage({ method: 'popup_clearUnexpectedError' })
	}

	const currentResults = simVisResults.value
	const shouldBlurSimulationContent = simulationResultState.value === 'invalid' || simulationUpdatingState.value === 'failed'
	const simulationErrorText = currentResults.kind === 'simulated' && currentResults.value.visualizedSimulationState.success === false
		? `Failed to simulate the stack due to error: "${ currentResults.value.visualizedSimulationState.jsonRpcError.error.message }". Please modify the stack to make it simutable.`
		: undefined

	return <main>
		<div class = 'layout simulation-stack-page'>
			{ !isSettingsLoaded.value ? <>
				<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value === undefined ? undefined : unexpectedError.value.data }/>
				<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
				{ rpcNetwork.value?.httpsRpc === undefined && rpcNetwork.value !== undefined ?
					<ErrorComponent text = { `${ rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ rpcNetwork.value.name }.` }/>
				: <></> }
				<CenterToPageTextSpinner/>
			</> : <>
				<SimulationStackToolbar
					openImportSimulation = { () => { modalState.value = { page: 'importSimulation', state: new Signal('') } } }
					resetSimulation = { resetSimulation }
					disableReset = { disableReset }
				/>
				<div class = 'simulation-stack-page-body'>
					<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value === undefined ? undefined : unexpectedError.value.data }/>
					<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
					{ rpcNetwork.value?.httpsRpc === undefined && rpcNetwork.value !== undefined ?
						<ErrorComponent text = { `${ rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ rpcNetwork.value.name }.` }/>
					: <></> }
					<ErrorBoundary key = { boundaryResetKey.value } onError = { onRenderError }>
					{ isEmpty.value ?
						<article class = 'simulation-stack-page-content'><DinoSays text = { 'Give me some transactions to munch on!' } /></article>
					: currentResults.kind === 'passthrough' ?
						<article class = 'simulation-stack-page-content'><RichAddressesTitleCard numberOfAddressesMadeRich = { numberOfAddressesMadeRich.value } madeRichAddressBookEntries = { madeRichAddressBookEntries.value } renameAddressCallBack = { renameAddressCallBack } /></article>
					: <article class = 'simulation-stack-page-content'>
						{ simulationErrorText === undefined ? <></> : <ErrorComponent text = { simulationErrorText }/> }
						<div class = { shouldBlurSimulationContent ? 'blur' : undefined }>
							<RichAddressesTitleCard numberOfAddressesMadeRich = { numberOfAddressesMadeRich.value } madeRichAddressBookEntries = { madeRichAddressBookEntries.value } renameAddressCallBack = { renameAddressCallBack } />
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
						</div>
					</article> }
					</ErrorBoundary>
				</div>
			</> }
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
