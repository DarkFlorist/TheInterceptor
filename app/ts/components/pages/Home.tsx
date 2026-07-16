import type { HomeParams, FirstCardParams, SimulationStateParam, RenameAddressCallBack, TabState } from '../../types/user-interface-types.js'
import { type SimulationAndVisualisationResults, isEmptySimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { ActiveAddressComponent, SmallAddress, WebsiteOriginText, getActiveAddressEntry } from '../subcomponents/address.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { TransactionsAndSignedMessages } from '../simulationExplaining/Transactions.js'
import { ICON_ACTIVE, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD } from '../../utils/constants.js'
import { getPrettySignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { BroomIcon, ChevronIcon, OpenInNewIcon } from '../subcomponents/icons.js'
import { RpcSelector } from '../subcomponents/ChainSelector.js'
import { type Signal, type ReadonlySignal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { type DeltaUnit, TimePicker, type TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { assertNever } from '../../utils/typescript.js'
import { bigintSecondsToDate } from '../../utils/bigint.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { useResetSimulation } from '../hooks/useResetSimulation.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'

function scheduleAfterPaint(callback: () => void) {
	if (typeof globalThis.requestAnimationFrame === 'function' && typeof globalThis.cancelAnimationFrame === 'function') {
		let secondFrame: number | undefined
		const firstFrame = globalThis.requestAnimationFrame(() => {
			secondFrame = globalThis.requestAnimationFrame(() => callback())
		})
		return () => {
			globalThis.cancelAnimationFrame(firstFrame)
			if (secondFrame !== undefined) globalThis.cancelAnimationFrame(secondFrame)
		}
	}
	const timeout = globalThis.setTimeout(callback, 32)
	return () => globalThis.clearTimeout(timeout)
}

type SignerExplanationParams = {
	activeAddress: Signal<AddressBookEntry | undefined>
	tabState: Signal<TabState | undefined>
}

function isSignerAvailable(tabState: TabState | undefined) {
	return tabState !== undefined && (tabState.signerConnected || tabState.signerAccounts.length > 0)
}

function SignerExplanation(param: SignerExplanationParams) {
	if (param.activeAddress.value !== undefined || param.tabState.value === undefined || param.tabState.value.signerAccountError !== undefined) return <></>
	if (!isSignerAvailable(param.tabState.value)) {
		if (param.tabState.value.signerName === 'NoSignerDetected' || param.tabState.value.signerName === 'NoSigner') return <ErrorComponent text = 'No signer installed. You need to install a signer, eg. Metamask.'/>
		return <ErrorComponent text = 'The page you are looking at has NOT CONNECTED to a wallet.'/>
	}
	return <ErrorComponent text = { `No account connected (or wallet is locked) in ${ param.tabState.value.signerName === 'NoSigner' ? 'signer' : getPrettySignerName(param.tabState.value.signerName) }.` }/>
}

function FirstCardHeader(param: FirstCardParams) {
	const tabIconReason = useComputed(() => param.tabIconDetails.value.iconReason)
	const signerName = useComputed(() => param.tabState.value?.signerName ?? 'NoSignerDetected')
	const { value: setSimulatingState, waitFor: waitForSetSimulating } = useAsyncState<void>()
	const { value: setSigningState, waitFor: waitForSetSigning } = useAsyncState<void>()
	const simulatingPending = setSimulatingState.value.state === 'pending'
	const signingPending = setSigningState.value.state === 'pending'

	async function enableSimulationMode(enabled: boolean ) {
		if (!param.isInitialHomeDataLoaded.value) return
		await sendPopupMessageToBackgroundPage( { method: 'popup_enableSimulationMode', data: enabled } )
	}
	const enableSimulating = () => {
		void waitForSetSimulating(() => enableSimulationMode(true))
	}
	const enableSigning = () => {
		void waitForSetSigning(() => enableSimulationMode(false))
	}

	return <>
		<header class = 'px-3 py-2' style = { { display: 'grid', gridTemplateColumns: 'max-content max-content minmax(0, max-content)', placeContent: 'space-between', columnGap: '1rem', alignItems: 'center' } }>
			<div>
				<ToolTip content = { tabIconReason }>
					<img class = 'noselect nopointer' src = { param.tabIconDetails.value.icon } width = '48' height = '48' style = { { display: 'block', width: '3rem', height: '3rem' } } />
				</ToolTip>
			</div>
			<div>
				<div class = 'buttons has-addons' style = 'border-style: solid; border-color: var(--primary-color); border-radius: 6px; padding: 1px; border-width: 1px; display: inline-flex; margin-bottom: 0;' >
					<AsyncActionButton
						class = { `button is-primary ${ param.simulationMode.value ? '' : 'is-outlined' }` }
						style = { `margin-bottom: 0px; ${ param.simulationMode.value ? 'opacity: 1;' : 'border-style: none;' }` }
						state = { setSimulatingState.value.state }
						disabled = { param.simulationMode.value || signingPending || !param.isInitialHomeDataLoaded.value }
						keepTextWhilePending = { true }
						pendingText = 'Switching to simulating mode...'
						text = 'Simulating'
						onClick = { enableSimulating }
					/>
					<AsyncActionButton
						class = { `button is-primary ${ param.simulationMode.value ? 'is-outlined' : ''}` }
						style = { `margin-bottom: 0px; ${ param.simulationMode.value ? 'border-style: none;' : 'opacity: 1;' }` }
						state = { setSigningState.value.state }
						disabled = { !param.simulationMode.value || simulatingPending || !param.isInitialHomeDataLoaded.value }
						keepTextWhilePending = { true }
						text = { <SignerLogoText signerName = { signerName } text = 'Signing' reserveLogoSpace = { true } /> }
						pendingText = 'Switching to signing mode...'
						onClick = { enableSigning }
					/>
				</div>
			</div>
			<RpcSelector rpcEntries = { param.rpcEntries } rpcNetwork = { param.rpcNetwork } changeRpc = { param.changeActiveRpc } disabled = { !param.isInitialHomeDataLoaded.value }/>
		</header>
	</>
}

type InterceptorDisabledButtonParams = {
	disableInterceptorToggle: (disabled: boolean) => Promise<void>,
	interceptorDisabled: Signal<boolean>,
	website: ReadonlySignal<Website | undefined>
	isInitialHomeDataLoaded: Signal<boolean>
}

function InterceptorDisabledButton({ disableInterceptorToggle, interceptorDisabled, website, isInitialHomeDataLoaded }: InterceptorDisabledButtonParams) {
	const { value: disableButtonState, waitFor: waitForDisableInterceptor } = useAsyncState<void>()
	const toggleInterceptor = () => {
		if (!isInitialHomeDataLoaded.value) return
		void waitForDisableInterceptor(() => disableInterceptorToggle(!interceptorDisabled.value))
	}

	return <AsyncActionButton
		disabled = { website.value === undefined || !isInitialHomeDataLoaded.value }
		state = { disableButtonState.value.state }
		class = { `button is-small ${ interceptorDisabled.value ? 'is-success' : 'is-primary' }` }
		text = { interceptorDisabled.value ? <>
			<span class = 'icon'> <img src = { ICON_ACTIVE } width = '24' height = '24'/> </span>
			<span> Enable</span>
		</> : <>
			<span class = 'icon'> <img src = { ICON_INTERCEPTOR_DISABLED } width = '24' height = '24'/> </span>
			<span> Disable</span>
		</> }
		pendingText = { interceptorDisabled.value ? 'Enabling interceptor...' : 'Disabling interceptor...' }
		onClick = { toggleInterceptor }
	/>
}

type RichListParams = {
	makeCurrentAddressRich: Signal<boolean>
	activeAddress: Signal<AddressBookEntry | undefined>
	richList: Signal<readonly EnrichedRichListElement[]>
	renameAddressCallBack: RenameAddressCallBack
	isInitialHomeDataLoaded: Signal<boolean>
}

function RichList({ makeCurrentAddressRich, activeAddress, richList, renameAddressCallBack, isInitialHomeDataLoaded }: RichListParams) {
	async function enableMakeCurrentAddressRich(enabled: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: enabled, address: 'CurrentAddress'} } )
		makeCurrentAddressRich.value = enabled
	}
	async function modifyRichList(addressBookEntry: AddressBookEntry, makeRich: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		richList.value = updateRichListAddress(
			richList.value,
			addressBookEntry.address,
			makeRich,
			(element) => element.addressBookEntry.address,
			() => ({ addressBookEntry, makingRich: true, type: 'UserAdded' as const }),
		)
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: makeRich, address: addressBookEntry.address } } )
	}

	const showList = useSignal<boolean>(false)

	const activeAddressSetAsRichViaFixedAddressList = useComputed(() =>
		richList.value.filter((element) => element.makingRich).some((element) => element.addressBookEntry.address === activeAddress.value?.address)
	)
	const visibleRichList = useComputed(() => {
		const peekedActiveAddress = activeAddress.peek() // peek active address here to avoid double render (changing active address retriggers rich bit later)
		if (peekedActiveAddress === undefined) return richList.value
		if (richList.value.some((element) => element.addressBookEntry.address === peekedActiveAddress.address)) return richList.value
		return [...richList.value, { addressBookEntry: peekedActiveAddress, makingRich: false, type: 'CurrentActiveAddress' as const }]
	})

	const numberOfRichAddresses = useComputed(() => richList.value.filter((element) => element.makingRich).length)

	return <>
		<header class = 'card-header' style = 'cursor: pointer;' onClick = { () => { showList.value = !showList.value } }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em; padding: 0 0.5rem;'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content;' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { makeCurrentAddressRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeCurrentAddressRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Make current account rich</p>
				</label>
			</p>
			<div class = 'card-header-icon noselect' style = 'cursor: pointer;'>
				{ numberOfRichAddresses.value === 0 ? <></> : <p class = 'paragraph checkbox-text' style = 'white-space: nowrap; color: gray; padding-right: 10px;'> (+{ numberOfRichAddresses.value } rich address{ numberOfRichAddresses.value > 1 ? 'es' : '' })</p> }
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showList.value
			? <> { !activeAddressSetAsRichViaFixedAddressList.value || activeAddress.value === undefined ? <></> : <>
				<div class = 'card-content-header' style = 'font-size: 0.8em;'>
					<label class = 'form-control' style = 'gap: 1em;'>
						<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { true } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null && activeAddress.value !== undefined) { modifyRichList(activeAddress.value, e.target.checked) } } } />
						<SmallAddress addressBookEntry = { activeAddress } renameAddressCallBack = { renameAddressCallBack } noCopying = { !isInitialHomeDataLoaded.value } noEditAddress = { !isInitialHomeDataLoaded.value } />
					</label>
				</div>
			</> } </>
			: <div class = 'card-content'>
				<div style = { { display: 'flex', flexDirection: 'column' } } >
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Addresses being made rich</p>
					{ visibleRichList.value.map((richListElement) =>
						<label class = 'form-control' style = 'gap: 1em;' key = { richListElement.addressBookEntry.address.toString() }>
							<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { richListElement.makingRich } aria-label = { `Toggle rich address ${ richListElement.addressBookEntry.address.toString() }` } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { modifyRichList(richListElement.addressBookEntry, e.target.checked) } } } />
							<SmallAddress addressBookEntry = { richListElement.addressBookEntry } renameAddressCallBack = { renameAddressCallBack } noCopying = { !isInitialHomeDataLoaded.value } noEditAddress = { !isInitialHomeDataLoaded.value }/>
						</label>
					) }
				</div>
			</div>
		}
	</>
}

function FirstCard(param: FirstCardParams) {
	const timeSelectorMode = useSignal<TimePickerMode>('For')
	const timeSelectorAbsoluteTime = useSignal<Date | undefined>(undefined)
	const timeSelectorDeltaValue = useSignal<bigint>(12n)
	const timeSelectorDeltaUnit = useSignal<DeltaUnit>('Seconds')
	const { value: connectToSignerButtonState, waitFor: waitForConnectToSigner } = useAsyncState<void>()
	const signerAvailable = useComputed(() => isSignerAvailable(param.tabState.value))

	const connectToSigner = () => {
		if (!param.isInitialHomeDataLoaded.value) return
		void waitForConnectToSigner(() => sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true }))
	}

	const timeSelectorOnChange = () => {
		if (!param.isInitialHomeDataLoaded.value) return
		const blockTimeManipulation = getTimeManipulatorFromSignals(timeSelectorMode.value, timeSelectorAbsoluteTime.value, timeSelectorDeltaValue.value, timeSelectorDeltaUnit.value)
		if (blockTimeManipulation.type === 'No Delay') return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION } })
		return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation } })
	}

	useSignalEffect(() => {
		const value = param.preSimulationBlockTimeManipulation.value
		switch(value?.type) {
			case 'AddToTimestamp': {
				timeSelectorMode.value = 'For'
				timeSelectorDeltaValue.value = value.deltaToAdd
				timeSelectorDeltaUnit.value = value.deltaUnit
				break
			}
			case 'SetTimetamp': {
				timeSelectorMode.value = 'Until'
				timeSelectorAbsoluteTime.value = bigintSecondsToDate(value.timeToSet)
				break
			}
			case undefined: break
			default: assertNever(value)
		}
	})

	if (param.tabState.value?.signerName === 'NoSigner' && param.simulationMode.value === false) {
		return <>
			<section class = 'card' style = 'margin: 10px;'>
				<FirstCardHeader { ...param }/>
				<div class = 'card-content'>
					<DinoSays text = { 'No signer connnected. You can use Interceptor in simulation mode without a signer, but signing mode requires a browser wallet.' } />
				</div>
			</section>
		</>
	}

	return <>
		<section class = 'card' style = 'margin: 10px;'>
			<FirstCardHeader { ...param }/>
			<div class = 'card-content'>
				{ param.useSignersAddressAsActiveAddress.value || !param.simulationMode.value ?
					<p style = 'color: var(--text-color); text-align: left; padding-bottom: 10px'>
						{ param.tabState.value === undefined || param.tabState.value?.signerName === 'NoSigner' ? <></> : <>Retrieving from&nbsp;<SignersLogoName signerName = { param.tabState.value.signerName } /></> }
						{ signerAvailable.value ? <span style = 'float: right; color: var(--primary-color);'>CONNECTED</span> : <span style = 'float: right; color: var(--negative-color);'>NOT CONNECTED</span> }
					</p>
					: <></>
				}

				<ActiveAddressComponent
					activeAddress = { param.activeAddress }
					buttonText = { 'Change' }
					disableButton = { !param.simulationMode.value || !param.isInitialHomeDataLoaded.value }
					noCopying = { !param.isInitialHomeDataLoaded.value }
					noEditAddress = { !param.isInitialHomeDataLoaded.value }
					changeActiveAddress = { param.changeActiveAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
				{ !param.simulationMode.value ? <>
					{ (param.tabState.value?.signerAccounts.length === 0 && param.tabIconDetails.value.icon !== ICON_NOT_ACTIVE && param.tabIconDetails.value.icon !== ICON_NOT_ACTIVE_WITH_SHIELD) ?
						<div style = 'margin-top: 5px'>
							<AsyncActionButton
								class = 'button is-primary'
								disabled = { !param.isInitialHomeDataLoaded.value }
								state = { connectToSignerButtonState.value.state }
								text = { <SignerLogoText
									signerName = { param.tabState.value?.signerName ?? 'NoSignerDetected' }
									text = { `Connect to ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` }
								/> }
								pendingText = { `Connecting to ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` }
								onClick = { connectToSigner }
							/>
						</div>
						: <p style = 'color: var(--subtitle-text-color);' class = 'subtitle is-7'> { ` You can change active address by changing it directly from ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` } </p>
					}
				</> : <div style = 'justify-content: space-between; padding-top: 10px;'>
					<RichList activeAddress = { param.activeAddress } makeCurrentAddressRich = { param.makeCurrentAddressRich } renameAddressCallBack = { param.renameAddressCallBack } richList = { param.richList } isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }/>
					<div style ='padding-bottom: 10px'/>
					<TimePicker
						startText = 'Delay first transaction'
						mode = { timeSelectorMode }
						absoluteTime = { timeSelectorAbsoluteTime }
						deltaValue = { timeSelectorDeltaValue }
						deltaUnit = { timeSelectorDeltaUnit }
						onChangedCallBack = { timeSelectorOnChange }
						removeNoDelayOption = { true }
						disabled = { !param.isInitialHomeDataLoaded.value }
					/>
				</div> }
			</div>
		</section>

		<SignerExplanation activeAddress = { param.activeAddress } tabState = { param.tabState }/>
	</>
}

export const isEmptySimulation = (simulationAndVisualisationResults: SimulationAndVisualisationResults) => {
	const simulationStateInput = simulationAndVisualisationResults.simulationStateInput
	if (simulationStateInput === undefined) return isEmptySimulationAndVisualisationResults(simulationAndVisualisationResults)
	return !simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
}

type SimulationResultsHeaderParams = {
	openSimulationStack?: () => void
	disableReset?: ReadonlySignal<boolean>
	resetSimulation?: () => Promise<void>
}

function SimulationResultsHeader(param: SimulationResultsHeaderParams) {
	const { value: clearSimulationState, waitFor: waitForClearSimulation } = useAsyncState<void>()
	const openStack = () => { param.openSimulationStack?.() }
	const resetSimulation = param.resetSimulation
	const clearSimulation = () => {
		if (resetSimulation === undefined) return
		void waitForClearSimulation(resetSimulation)
	}

	return <div style = 'display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding-left: 10px; padding-right: 10px' >
		<div class = 'log-cell' style = 'justify-content: left; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;'>
			<p class = 'h1' style = 'margin: 0;'> Simulation Results </p>
		</div>
		<div class = 'log-cell' style = 'justify-content: right; align-items: center; gap: 6px; flex-wrap: wrap; max-width: 300px;'>
			{ param.openSimulationStack === undefined ? <></> :
				<button class = 'btn btn--outline is-small' onClick = { openStack } title = 'Open simulation stack details in a new tab' aria-label = 'Open simulation stack details in a new tab'>
					<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
						<OpenInNewIcon/>
					</span>
					<span>View stack details</span>
				</button>
			}
			{ param.disableReset === undefined || param.resetSimulation === undefined ? <></> :
				<AsyncActionButton
					class = 'btn is-small is-danger'
					state = { clearSimulationState.value.state }
					disabled = { param.disableReset.value }
					onClick = { clearSimulation }
					text = { <>
						<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
							<BroomIcon />
						</span>
						<span>Clear</span>
					</> }
					pendingText = 'Clearing...'
				/>
			}
		</div>
	</div>
}

function RichAddressesTitleCard({ numberOfAddressesMadeRich, openSimulationStack }: { numberOfAddressesMadeRich: number, openSimulationStack?: () => void }) {
	if (numberOfAddressesMadeRich === 0) return <></>
	const actionLabel = 'Open rich address state in the full simulation stack'
	const openStack = () => { openSimulationStack?.() }
	return <section class = 'card' style = 'margin: 10px;'>
		<header
			class = { `card-header stack-card-header${ openSimulationStack === undefined ? '' : ' stack-row-link-header' }` }
			onClick = { openStack }
			onKeyDown = { (event) => {
				if (openSimulationStack === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
				if (event.target !== event.currentTarget) return
				event.preventDefault()
				openStack()
			} }
			role = { openSimulationStack === undefined ? undefined : 'button' }
			tabIndex = { openSimulationStack === undefined ? undefined : 0 }
			title = { openSimulationStack === undefined ? undefined : actionLabel }
			aria-label = { openSimulationStack === undefined ? undefined : actionLabel }
		>
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

function PopupVisualisation(param: SimulationStateParam) {
	const isEmpty = useComputed(() => {
		if (param.numberOfAddressesMadeRich.value > 0) return false
		if (param.simulationAndVisualisationResults.value.kind === 'passthrough') return true
		return isEmptySimulation(param.simulationAndVisualisationResults.value.value)
	})

	const computedAddressBookEntries = useComputed(() => param.simulationAndVisualisationResults.value.kind === 'simulated' ? param.simulationAndVisualisationResults.value.value.addressBookEntries : [])
	const currentResults = param.simulationAndVisualisationResults.value
	const isSimulationStatusUnknown = param.simulationUpdatingState.value === undefined || param.simulationResultState.value === undefined

	if (isSimulationStatusUnknown || (isEmpty.value && param.simulationUpdatingState.value === 'updating')) {
		return <div style = 'display: grid; place-items: center; height: 250px;'>
			<Spinner height = '3em'/>
		</div>
	}

	if (currentResults.kind === 'passthrough') {
		return <div>
			<SimulationResultsHeader openSimulationStack = { param.openSimulationStack } />
			{ isEmpty.value ?
				<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
			: <RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } /> }
		</div>
	}

	const resolvedResults = currentResults.value

	return <div>
		<SimulationResultsHeader openSimulationStack = { param.openSimulationStack } disableReset = { param.disableReset } resetSimulation = { param.resetSimulation } />

			{ resolvedResults.visualizedSimulationState.success === false ? <>
				<ErrorComponent text = { `Failed to simulate the stack due to error: "${ resolvedResults.visualizedSimulationState.jsonRpcError.error.message }". Please modify the stack to make it simutable.` }/>
				<RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } />
				<TransactionsAndSignedMessages
				simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
				removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
				activeAddress = { param.activeSimulationAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				addressMetaData = { computedAddressBookEntries }
				displayMode = 'titleOnly'
				openSimulationStackAt = { param.openSimulationStack }
			/>
		</> : <>
			{ isEmpty.value ?
				<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
			: <>
				<div class = { param.simulationResultState.value === 'invalid' || param.simulationUpdatingState.value === 'failed' ? 'blur' : '' }>
					<RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } />
					<TransactionsAndSignedMessages
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
						activeAddress = { param.activeSimulationAddress }
						renameAddressCallBack = { param.renameAddressCallBack }
						editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
						addressMetaData = { computedAddressBookEntries }
						displayMode = 'titleOnly'
						openSimulationStackAt = { param.openSimulationStack }
					/>
					{ param.removedTransactionOrSignedMessages.length > 0
						? <></>
						: <SimulationSummary
							simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
							currentBlockNumber = { param.currentBlockNumber }
							activeAddress = { param.activeSimulationAddress }
							renameAddressCallBack = { param.renameAddressCallBack }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					}
				</div>
			</> }
		</> }
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

export function Home(param: HomeParams) {
	const { disableReset, resetSimulation, markSimulationDataReceived } = useResetSimulation()
	const removedTransactionOrSignedMessages = useSignal<readonly TransactionOrMessageIdentifier[]>([])
	const showPopupVisualisation = useSignal<boolean>(false)
	const tabWebsite = useComputed(() => param.tabState.value?.website)
	const disableResetUntilHomeDataLoaded = useComputed(() => disableReset.value || !param.isInitialHomeDataLoaded.value)

	const activeSimulationAddress = useComputed(() =>
		param.activeSimulationAddress.value !== undefined ? getActiveAddressEntry(param.activeSimulationAddress.value, param.activeAddresses.value) : undefined
	)
	const activeSigningAddress = useComputed(() =>
		param.activeSigningAddress.value !== undefined ? getActiveAddressEntry(param.activeSigningAddress.value, param.activeAddresses.value) : undefined
	)
	const currentActiveAddress = useComputed(() => param.simulationMode.value ? activeSimulationAddress.value : activeSigningAddress.value)

	useEffect(() => {
		if (!param.simulationMode.value || activeSimulationAddress.value === undefined) {
			showPopupVisualisation.value = false
			return
		}
		if (showPopupVisualisation.value) return
		return scheduleAfterPaint(() => {
			showPopupVisualisation.value = true
		})
	}, [param.simulationMode.value, activeSimulationAddress.value])

	useSignalEffect(() => {
		param.simVisResults.value
		markSimulationDataReceived()
		removedTransactionOrSignedMessages.value = []
	})

	async function removeTransactionOrSignedMessage(transactionOrMessageIdentifier: TransactionOrMessageIdentifier) {
		if (!param.isInitialHomeDataLoaded.value) return
		removedTransactionOrSignedMessages.value = [...removedTransactionOrSignedMessages.value, transactionOrMessageIdentifier]
		return await sendPopupMessageToBackgroundPage({ method: 'popup_removeTransactionOrSignedMessage', data: transactionOrMessageIdentifier })
	}

	async function disableInterceptorToggle() {
		if (!param.isInitialHomeDataLoaded.value) return
		if (param.tabState.value?.website === undefined) return
		const newValue = !param.interceptorDisabled.value
		await sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor', data: { interceptorDisabled: newValue, website: param.tabState.value.website } })
	}

	async function resetSimulationAfterHomeDataLoaded() {
		if (!param.isInitialHomeDataLoaded.value) return
		await resetSimulation()
	}

	async function openSimulationStack(target?: TransactionOrMessageIdentifier) {
		await sendPopupMessageToBackgroundPage(target === undefined
			? { method: 'popup_openSimulationStack' }
			: { method: 'popup_openSimulationStack', data: target }
		)
		globalThis.close()
	}

	if (param.rpcNetwork.value === undefined) return <></>

	return <>
		{ param.rpcNetwork.value.httpsRpc === undefined ?
			<ErrorComponent text = { `${ param.rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ param.rpcNetwork.value.name }.` }/>
		: <></> }

		<FirstCard
			preSimulationBlockTimeManipulation = { param.preSimulationBlockTimeManipulation }
			activeAddresses = { param.activeAddresses }
			useSignersAddressAsActiveAddress = { param.useSignersAddressAsActiveAddress }
			activeAddress = { currentActiveAddress }
			rpcNetwork = { param.rpcNetwork }
			changeActiveRpc = { param.setActiveRpcAndInformAboutIt }
			simulationMode = { param.simulationMode }
			changeActiveAddress = { param.changeActiveAddress }
			makeCurrentAddressRich = { param.makeCurrentAddressRich }
			richList = { param.fixedAddressRichList }
			tabState = { param.tabState }
			tabIconDetails = { param.tabIconDetails }
			renameAddressCallBack = { param.renameAddressCallBack }
			rpcEntries = { param.rpcEntries }
			isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }
		/>

		{ param.simulationMode.value && activeSimulationAddress.value !== undefined
			? showPopupVisualisation.value
				? <PopupVisualisation
					simulationAndVisualisationResults = { param.simVisResults }
					removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
					disableReset = { disableResetUntilHomeDataLoaded }
					resetSimulation = { resetSimulationAfterHomeDataLoaded }
					currentBlockNumber = { param.currentBlockNumber }
					activeSimulationAddress = { param.activeSimulationAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					removedTransactionOrSignedMessages = { removedTransactionOrSignedMessages.value }
					rpcConnectionStatus = { param.rpcConnectionStatus }
					simulationUpdatingState = { param.simulationUpdatingState }
					simulationResultState = { param.simulationResultState }
					openSimulationStack = { openSimulationStack }
					numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich }
				/>
				: <section class = 'card' style = 'margin: 10px; min-height: 250px; display: grid; place-items: center;'>
					<Spinner height = '3em'/>
				</section>
			: <></> }
		{ tabWebsite.value === undefined ? <></> : <>
			<div style = 'padding-top: 50px' />
			<div class = 'popup-footer' style = 'display: flex; justify-content: center; flex-direction: column;'>
				<div style = 'display: grid; grid-template-columns: auto auto; padding-left: 10px; padding-right: 10px' >
					<div class = 'log-cell' style = 'justify-content: left;'>
						<WebsiteOriginText website = { tabWebsite } />
					</div>
					<div class = 'log-cell' style = 'justify-content: right; padding-left: 20px'>
						<InterceptorDisabledButton website = { tabWebsite } disableInterceptorToggle = { disableInterceptorToggle } interceptorDisabled = { param.interceptorDisabled } isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }/>
					</div>
				</div>
			</div>
		</> }
	</>
}
