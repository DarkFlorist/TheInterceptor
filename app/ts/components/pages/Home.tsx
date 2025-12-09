import { HomeParams, FirstCardParams, SimulationStateParam, TabIconDetails, TabIcon, TabState, RenameAddressCallBack } from '../../types/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { SimulationAndVisualisationResults, SimulationUpdatingState, SimulationResultState } from '../../types/visualizer-types.js'
import { ActiveAddressComponent, SmallAddress, WebsiteOriginText, getActiveAddressEntry } from '../subcomponents/address.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { DEFAULT_TAB_CONNECTION, ICON_ACTIVE, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD } from '../../utils/constants.js'
import { getPrettySignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { TransactionsAndSignedMessages } from '../simulationExplaining/Transactions.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { BroomIcon, ChevronIcon } from '../subcomponents/icons.js'
import { RpcSelector } from '../subcomponents/ChainSelector.js'
import { Signal, useComputed, useSignal } from '@preact/signals'
import { DeltaUnit, TimePicker, TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { assertNever } from '../../utils/typescript.js'
import { bigintSecondsToDate } from '../../utils/bigint.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../simulation/services/SimulationModeEthereumClientService.js'

type SignerExplanationParams = {
	activeAddress: AddressBookEntry | undefined
	simulationMode: Signal<boolean>
	tabState: TabState | undefined
	useSignersAddressAsActiveAddress: boolean
	tabIcon: TabIcon
}

function SignerExplanation(param: SignerExplanationParams) {
	if (param.activeAddress !== undefined || param.tabState === undefined || param.tabState.signerAccountError !== undefined) return <></>
	if (!param.tabState.signerConnected) {
		if (param.tabState.signerName === 'NoSignerDetected' || param.tabState.signerName === 'NoSigner') return <ErrorComponent text = 'No signer installed. You need to install a signer, eg. Metamask.'/>
		return <ErrorComponent text = 'The page you are looking at has NOT CONNECTED to a wallet.'/>
	}
	return <ErrorComponent text = { `No account connected (or wallet is locked) in ${ param.tabState.signerName === 'NoSigner' ? 'signer' : getPrettySignerName(param.tabState.signerName) }.` }/>
}

function FirstCardHeader(param: FirstCardParams) {

	function enableSimulationMode(enabled: boolean ) {
		param.simulationMode.value = enabled
		sendPopupMessageToBackgroundPage( { method: 'popup_enableSimulationMode', data: enabled } )
	}

	return <>
		<header class = 'px-3 py-2' style = { { display: 'grid', gridTemplateColumns: 'max-content max-content minmax(0, 1fr)', columnGap: '1rem', alignItems: 'center' } }>
			<div>
				<ToolTip content = {  param.tabIconDetails.iconReason }>
					<img className = 'noselect nopointer' src = { param.tabIconDetails.icon } style = { { display: 'block', width: '3rem', height: '3rem' } } />
				</ToolTip>
			</div>
			<div>
				<div class = 'buttons has-addons' style = 'border-style: solid; border-color: var(--primary-color); border-radius: 6px; padding: 1px; border-width: 1px; display: inline-flex; margin-bottom: 0;' >
					<button
						class = { `button is-primary ${ param.simulationMode.value ? '' : 'is-outlined' }` }
						style = { `margin-bottom: 0px; ${ param.simulationMode.value ? 'opacity: 1;' : 'border-style: none;' }` }
						disabled = { param.simulationMode.value }
						onClick = { () => enableSimulationMode(true) }>
						Simulating
					</button>
					<button
						class = { `button is-primary ${ param.simulationMode.value ? 'is-outlined' : ''}` }
						style = { `margin-bottom: 0px; ${ param.simulationMode.value ? 'border-style: none;' : 'opacity: 1;' }` }
						disabled = { !param.simulationMode.value }
						onClick = { () => enableSimulationMode(false) }>
						<SignerLogoText signerName = { param.tabState?.signerName ?? 'NoSignerDetected' } text = { 'Signing' } />
					</button>
				</div>
			</div>
			<div style = 'display: flex; justify-content: right'>
				<RpcSelector rpcEntries = { param.rpcEntries } rpcNetwork = { param.rpcNetwork } changeRpc = { param.changeActiveRpc }/>
			</div>
		</header>
	</>
}

type InterceptorDisabledButtonParams = {
	disableInterceptorToggle: (disabled: boolean) => void,
	interceptorDisabled: boolean,
	website: Website | undefined
}

function InterceptorDisabledButton({ disableInterceptorToggle, interceptorDisabled, website }: InterceptorDisabledButtonParams) {
	return <button disabled = { website === undefined } className = { `button is-small ${ interceptorDisabled ? 'is-success' : 'is-primary' }` } onClick = { () => disableInterceptorToggle(!interceptorDisabled) } >
		{ interceptorDisabled ? <>
			<span class = 'icon'> <img src = { ICON_ACTIVE }/> </span>
			<span> Enable</span>
		</> : <>
			<span class = 'icon'> <img src = { ICON_INTERCEPTOR_DISABLED }/> </span>
			<span> Disable</span>
		</> }
	</button>
}

type RichListParams = {
	makeMeRich: Signal<boolean>
	keepSelectedAddressRichEvenIfIChangeAddress: Signal<boolean>
	richList: Signal<readonly AddressBookEntry[]>
	renameAddressCallBack: RenameAddressCallBack,
}

function RichList(param: RichListParams) {
	async function enableMakeMeRich(enabled: boolean) {
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: enabled, address: 'CurrentAddress'} } )
		param.makeMeRich.value = enabled
	}
	async function enableKeepSelectedAddressRichEvenIfIChangeAddress(enabled: boolean) {
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: enabled, address: 'KeepSelectedAddressRichEvenIfIChangeAddress' } } )
		param.keepSelectedAddressRichEvenIfIChangeAddress.value = enabled
	}
	async function removeAddressFromRichList(address: bigint, add: boolean) {
		if (!add) {
			param.richList.value = param.richList.value.filter((x) => x.address !== address)
		}
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add, address } } )
	}

	const showList = useSignal<boolean>(false)

	return <>
		<header class = 'card-header' style = 'cursor: pointer;' onClick = { () => { showList.value = !showList.value } }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em; padding: 0 0.5rem;'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content;' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' checked = { param.makeMeRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeMeRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'>Make me rich</p>
				</label>
			</p>
			<div class = 'card-header-icon noselect' style = 'cursor: pointer;'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showList.value
			? <></>
			: <div class = 'card-content'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content; padding-bottom: 10px' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' checked = { param.keepSelectedAddressRichEvenIfIChangeAddress.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableKeepSelectedAddressRichEvenIfIChangeAddress(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'>Keep selected address rich even if I change address</p>
				</label>

				<div style = { { display: 'flex', flexDirection: 'column' } } >
					{ param.richList.value.length === 0 ? <p class = 'paragraph'> No addresses being made rich</p> : <p class = 'paragraph'> Addresses being made rich:</p> }
					{ param.richList.value.map((addressBookEntry) => {
						return <label class = 'form-control' style = 'gap: 1em;'>
							<input type = 'checkbox' checked = { true } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { removeAddressFromRichList(addressBookEntry.address, false) } } } />
								<p class = 'paragraph'>
									<SmallAddress
										addressBookEntry = { addressBookEntry }
										renameAddressCallBack = { param.renameAddressCallBack }
									/>
								</p>
						</label>
					}) }
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

	const timeSelectorOnChange = () => {
		const blockTimeManipulation = getTimeManipulatorFromSignals(timeSelectorMode.value, timeSelectorAbsoluteTime.value, timeSelectorDeltaValue.value, timeSelectorDeltaUnit.value)
		if (blockTimeManipulation.type === 'No Delay') return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION } })
		return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation } })
	}

	useEffect(() => {
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
	}, [param.preSimulationBlockTimeManipulation])

	if (param.tabState?.signerName === 'NoSigner' && param.simulationMode.value === false) {
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
				{ param.useSignersAddressAsActiveAddress || !param.simulationMode.value ?
					<p style = 'color: var(--text-color); text-align: left; padding-bottom: 10px'>
						{ param.tabState === undefined || param.tabState?.signerName === 'NoSigner' ? <></> : <>Retrieving from&nbsp;<SignersLogoName signerName = { param.tabState.signerName } /></> }
						{ param.tabState?.signerConnected ? <span style = 'float: right; color: var(--primary-color);'>CONNECTED</span> : <span style = 'float: right; color: var(--negative-color);'>NOT CONNECTED</span> }
					</p>
					: <></>
				}

				<ActiveAddressComponent
					activeAddress = { param.activeAddress }
					buttonText = { 'Change' }
					disableButton = { !param.simulationMode.value }
					changeActiveAddress = { param.changeActiveAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
				{ !param.simulationMode.value ? <>
					{ (param.tabState?.signerAccounts.length === 0 && param.tabIconDetails.icon !== ICON_NOT_ACTIVE && param.tabIconDetails.icon !== ICON_NOT_ACTIVE_WITH_SHIELD) ?
						<div style = 'margin-top: 5px'>
							<button className = 'button is-primary' onClick = { () => sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true }) } >
								<SignerLogoText
									signerName = { param.tabState.signerName }
									text = { `Connect to ${ getPrettySignerName(param.tabState.signerName) }` }
								/>
							</button>
						</div>
						: <p style = 'color: var(--subtitle-text-color);' class = 'subtitle is-7'> { ` You can change active address by changing it directly from ${ getPrettySignerName(param.tabState?.signerName ?? 'NoSignerDetected') }` } </p>
					}
				</> : <div style = 'justify-content: space-between; padding-top: 10px;'>
					<RichList keepSelectedAddressRichEvenIfIChangeAddress = { param.keepSelectedAddressRichEvenIfIChangeAddress } makeMeRich = { param.makeMeRich } renameAddressCallBack = { param.renameAddressCallBack } richList = { param.richList }/>
					<div style ='padding-bottom: 10px'/>
					<TimePicker
						startText = 'Simulate delay before first transaction'
						mode = { timeSelectorMode }
						absoluteTime = { timeSelectorAbsoluteTime }
						deltaValue = { timeSelectorDeltaValue }
						deltaUnit = { timeSelectorDeltaUnit }
						onChangedCallBack = { timeSelectorOnChange }
						removeNoDelayOption = { true }
					/>
				</div> }
			</div>
		</section>

		<SignerExplanation
			activeAddress = { param.activeAddress }
			simulationMode = { param.simulationMode }
			tabState = { param.tabState }
			useSignersAddressAsActiveAddress = { param.useSignersAddressAsActiveAddress }
			tabIcon = { param.tabIconDetails.icon }
		/>
	</>
}

export const isEmptySimulation = (simulationAndVisualisationResults: SimulationAndVisualisationResults) => {
	return !simulationAndVisualisationResults.visualizedSimulationState.visualizedBlocks
		.map((block) => block.simulatedAndVisualizedTransactions.length + block.visualizedPersonalSignRequests.length > 0)
		.some((isThereSomethingToSimulate) => isThereSomethingToSimulate)
}

function SimulationResults(param: SimulationStateParam) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const isEmpty = useComputed(() => {
		if (param.simulationAndVisualisationResults === undefined) return true
		return isEmptySimulation(param.simulationAndVisualisationResults)
	})
	return <div>
		<div style = 'display: grid; grid-template-columns: auto auto; padding-left: 10px; padding-right: 10px' >
			<div class = 'log-cell' style = 'justify-content: left;'>
				<p className = 'h1'> Simulation Results </p>
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				<button className = 'button is-small is-danger' disabled = { param.disableReset } onClick = { param.resetSimulation } >
					<span style = {{ marginRight: '0.25rem', fontSize: '1rem' }}>
						<BroomIcon />
					</span>
					<span>Clear</span>
				</button>
			</div>
		</div>
		{ isEmpty.value ?
			<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
		: <>
			<div class = { param.simulationResultState === 'invalid' || param.simulationUpdatingState === 'failed' ? 'blur' : '' }>
				<TransactionsAndSignedMessages
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
					activeAddress = { param.simulationAndVisualisationResults.activeAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					removedTransactionOrSignedMessages = { param.removedTransactionOrSignedMessages }
					addressMetaData = { param.simulationAndVisualisationResults.addressBookEntries }
				/>
				{ param.removedTransactionOrSignedMessages.length > 0
					? <></>
					: <SimulationSummary
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						currentBlockNumber = { param.currentBlockNumber }
						renameAddressCallBack = { param.renameAddressCallBack }
						rpcConnectionStatus = { param.rpcConnectionStatus }
					/>
				}
			</div>
		</> }
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

export function Home(param: HomeParams) {
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<AddressBookEntry | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<AddressBookEntry | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined>(undefined)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [tabState, setTabState] = useState<TabState | undefined>(undefined)
	const [isLoaded, setLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [disableReset, setDisableReset] = useState<boolean>(false)
	const [removedTransactionOrSignedMessages, setRemovedTransactionOrSignedMessages] = useState<readonly TransactionOrMessageIdentifier[]>([])
	const [simulationUpdatingState, setSimulationUpdatingState] = useState<SimulationUpdatingState | undefined>(undefined)
	const [simulationResultState, setSimulationResultState] = useState<SimulationResultState | undefined>(undefined)
	const [interceptorDisabled, setInterceptorDisabled] = useState<boolean>(false)

	useEffect(() => {
		setSimulationAndVisualisationResults(param.simVisResults)
		setUseSignersAddressAsActiveAddress(param.useSignersAddressAsActiveAddress)
		setActiveSimulationAddress(param.activeSimulationAddress !== undefined ? getActiveAddressEntry(param.activeSimulationAddress, param.activeAddresses.value) : undefined)
		setActiveSigningAddress(param.activeSigningAddress !== undefined ? getActiveAddressEntry(param.activeSigningAddress, param.activeAddresses.value) : undefined)
		setTabConnection(param.tabIconDetails)
		setTabState(param.tabState)
		setCurrentBlockNumber(param.currentBlockNumber)
		setLoaded(true)
		setDisableReset(false)
		setRemovedTransactionOrSignedMessages([])
		setSimulationUpdatingState(param.simulationUpdatingState)
		setSimulationResultState(param.simulationResultState)
		setInterceptorDisabled(param.interceptorDisabled)
	}, [param.activeSigningAddress,
		param.activeSimulationAddress,
		param.tabState,
		param.useSignersAddressAsActiveAddress,
		param.rpcNetwork.value,
		param.tabIconDetails,
		param.currentBlockNumber,
		param.simVisResults,
		param.rpcConnectionStatus,
		param.simulationUpdatingState,
		param.simulationResultState,
		param.interceptorDisabled,
	])

	function resetSimulation() {
		setDisableReset(true)
		sendPopupMessageToBackgroundPage({ method: 'popup_resetSimulation' })
	}

	async function removeTransactionOrSignedMessage(transactionOrMessageIdentifier: TransactionOrMessageIdentifier) {
		setRemovedTransactionOrSignedMessages((transactionOrMessageIdentifiers) => transactionOrMessageIdentifiers.concat(transactionOrMessageIdentifier))
		return await sendPopupMessageToBackgroundPage({ method: 'popup_removeTransactionOrSignedMessage', data: transactionOrMessageIdentifier })
	}

	async function disableInterceptorToggle() {
		setInterceptorDisabled((previousValue) => {
			if (tabState?.website === undefined) return previousValue
			const newValue = !previousValue
			sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor', data: { interceptorDisabled: newValue, website: tabState.website } })
			return previousValue
		})
	}

	if (!isLoaded || param.rpcNetwork.value === undefined) return <> </>

	return <>
		{ param.rpcNetwork.value.httpsRpc === undefined ?
			<ErrorComponent text = { `${ param.rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ param.rpcNetwork.value.name }.` }/>
		: <></> }

		<FirstCard
			preSimulationBlockTimeManipulation = { param.preSimulationBlockTimeManipulation }
			activeAddresses = { param.activeAddresses }
			useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
			activeAddress = { param.simulationMode.value ? activeSimulationAddress : activeSigningAddress }
			rpcNetwork = { param.rpcNetwork }
			changeActiveRpc = { param.setActiveRpcAndInformAboutIt }
			simulationMode = { param.simulationMode }
			changeActiveAddress = { param.changeActiveAddress }
			makeMeRich = { param.makeMeRich }
			richList = { param.makeMeRichList }
			keepSelectedAddressRichEvenIfIChangeAddress = { param.keepSelectedAddressRichEvenIfIChangeAddress }
			tabState = { tabState }
			tabIconDetails = { tabIconDetails }
			renameAddressCallBack = { param.renameAddressCallBack }
			rpcEntries = { param.rpcEntries }
		/>

		{ param.simulationMode.value && activeSimulationAddress !== undefined ? <SimulationResults
			simulationAndVisualisationResults = { simulationAndVisualisationResults }
			removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
			disableReset = { disableReset }
			resetSimulation = { resetSimulation }
			currentBlockNumber = { currentBlockNumber }
			renameAddressCallBack = { param.renameAddressCallBack }
			editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
			removedTransactionOrSignedMessages = { removedTransactionOrSignedMessages }
			rpcConnectionStatus = { param.rpcConnectionStatus }
			simulationUpdatingState = { simulationUpdatingState }
			simulationResultState = { simulationResultState }
		/> : <> </> }
		{ tabState?.website === undefined ? <></> : <>
			<div style = 'padding-top: 50px' />
			<div class = 'popup-footer' style = 'display: flex; justify-content: center; flex-direction: column;'>
				<div style = 'display: grid; grid-template-columns: auto auto; padding-left: 10px; padding-right: 10px' >
					<div class = 'log-cell' style = 'justify-content: left;'>
						<WebsiteOriginText { ...tabState?.website } />
					</div>
					<div class = 'log-cell' style = 'justify-content: right; padding-left: 20px'>
						<InterceptorDisabledButton website = { tabState.website } disableInterceptorToggle = { disableInterceptorToggle } interceptorDisabled = { interceptorDisabled }/>
					</div>
				</div>
			</div>
		</> }
	</>
}
