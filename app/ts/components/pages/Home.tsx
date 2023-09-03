import { HomeParams, FirstCardParams, SimulationStateParam, RpcConnectionStatus, TabIconDetails, TabIcon } from '../../types/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, RpcEntry, RpcNetwork, RpcEntries, SimulationUpdatingState, SimulationResultState } from '../../types/visualizer-types.js'
import { ActiveAddress, findAddressInfo } from '../subcomponents/address.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { DEFAULT_TAB_CONNECTION, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { getPrettySignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { Error } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { Transactions } from '../simulationExplaining/Transactions.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { humanReadableDate } from '../ui-utils.js'
import { noNewBlockForOverTwoMins } from '../../background/iconHandler.js'
import { AddressInfo } from '../../types/addressBookTypes.js'
import { SignerName } from '../../types/signerTypes.js'

async function enableMakeMeRich(enabled: boolean) {
	sendPopupMessageToBackgroundPage( { method: 'popup_changeMakeMeRich', data: enabled } )
}

type SignerExplanationParams = {
	activeAddress: AddressInfo | undefined
	simulationMode: boolean
	signerName: SignerName
	useSignersAddressAsActiveAddress: boolean
	tabIcon: TabIcon
}

function SignerExplanation(param: SignerExplanationParams) {
	if (param.activeAddress !== undefined) return <></>
	if (param.tabIcon === ICON_NOT_ACTIVE) {
		return <>
			<div class = 'notification' style = 'background-color: var(--card-content-bg-color); padding: 10px; margin: 10px;'>
				<DinoSays text = 'The page you are looking at has not connected to a wallet, or you do not have a browser wallet installed.'/>
			</div>
		</>
	}
	if (param.useSignersAddressAsActiveAddress || !param.simulationMode) {
		return  <>
			<div class = 'notification' style = 'background-color: var(--card-content-bg-color); padding: 10px; margin: 10px;'>
				<DinoSays text = { `Please make sure that you have gone through the wallet connection process on the page and allowed the page to see your ${ param.signerName === 'NoSigner' ? 'signer' : getPrettySignerName(param.signerName) } account.` }/>
			</div>
		</>
	}
	return <></>
}

function FirstCardHeader(param: FirstCardParams) {
	return <>
		<header class = 'card-header'>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon' style = 'height: 3rem; width: 3rem;'>
					<ToolTip content = {  param.tabIconDetails.iconReason }>
						<img className = 'noselect nopointer' src = { param.tabIconDetails.icon } />
					</ToolTip>
				</span>
			</div>
			<div class = 'card-header-title px-0 is-justify-content-center'>
				<div class = 'buttons has-addons' style = 'border-style: solid; border-color: var(--primary-color); border-radius: 4px; padding: 1px; border-width: 1px; margin-bottom: 0px; flex-wrap: nowrap;' >
					<button
						class = { `button is-primary ${ param.simulationMode ? '' : 'is-outlined' }` }
						style = { `margin-bottom: 0px; ${ param.simulationMode ? 'opacity: 1;' : 'border-style: none;' }` }
						disabled = { param.simulationMode }
						onClick = { () => param.enableSimulationMode(true) }>
						Simulating
					</button>
					<button
						class = { `button is-primary ${ param.simulationMode ? 'is-outlined' : ''}` }
						style = { `margin-bottom: 0px; ${ param.simulationMode ? 'border-style: none;' : 'opacity: 1;' }` }
						disabled = { !param.simulationMode }
						onClick = { () => param.enableSimulationMode(false) }>
						<SignerLogoText signerName = { param.signerName } text = { 'Signing' } />
					</button>
				</div>
			</div>
			<div class = 'card-header-icon unset-cursor'>
				<ChainSelector rpcEntries = { param.rpcEntries } rpcNetwork = { param.rpcNetwork } changeRpc = { (entry: RpcEntry) => { param.changeActiveRpc(entry) } }/>
			</div>
		</header>
	</>
}

function FirstCard(param: FirstCardParams) {
	function connectToSigner() {
		sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true })
	}

	if (param.signerName === 'NoSigner' && param.simulationMode === false) {
		return <>
			<div class = 'card' style = 'margin: 10px;'>
				<FirstCardHeader { ...param }/>
				<div class = 'card-content'>
					<DinoSays text = { 'No signer connnected. You can use Interceptor in simulation mode without a signer, but signing mode requires a browser wallet.' } />
				</div>
			</div>
		</>
	}

	return <>
		<div class = 'card' style = 'margin: 10px;'>
			<FirstCardHeader { ...param }/>
			<div class = 'card-content'>
				{ param.useSignersAddressAsActiveAddress || !param.simulationMode ?
					<p style = 'color: var(--text-color); text-align: left; padding-bottom: 10px'>
						{ param.signerName === 'NoSigner'
							? 'Retrieving address from a signer'
							: <>Retrieving from&nbsp;<SignersLogoName signerName = { param.signerName } /></>
						}
						{ param.signerAccounts !== undefined && param.signerAccounts.length > 0 && param.tabIconDetails.icon !== ICON_NOT_ACTIVE ? <span style = 'float: right; color: var(--primary-color);'> CONNECTED </span> :
							param.tabIconDetails.icon === ICON_SIGNING || param.tabIconDetails.icon === ICON_SIGNING_NOT_SUPPORTED ? <span style = 'float: right; color: var(--negative-color);'> NOT CONNECTED </span> : <></>
						}
					</p>
					: <></>
				}

				<ActiveAddress
					activeAddress = { param.activeAddress !== undefined ? { type: 'addressInfo', ...param.activeAddress, entrySource: 'User' } : undefined }
					buttonText = { 'Change' }
					disableButton = { !param.simulationMode }
					changeActiveAddress = { param.changeActiveAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
				{ !param.simulationMode ?
					( (param.signerAccounts === undefined || param.signerAccounts.length == 0) && param.tabIconDetails.icon !== ICON_NOT_ACTIVE ) ?
						<div style = 'margin-top: 5px'>
							<button className = 'button is-primary' onClick = { connectToSigner } >
								<SignerLogoText
									signerName = { param.signerName }
									text = { `Connect to ${ getPrettySignerName(param.signerName) }` }
								/>
							</button>
						</div>
					: <p style = 'color: var(--subtitle-text-color);' class = 'subtitle is-7'> { ` You can change active address by changing it directly from ${ getPrettySignerName(param.signerName) }` } </p>
				:
					<label class = 'form-control' style = 'padding-top: 10px'>
						<input type = 'checkbox' checked = { param.makeMeRich } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeMeRich(e.target.checked) } } } />
						<p class = 'paragraph checkbox-text'>Make me rich</p>
					</label>
				}
			</div>
		</div>
	
		<SignerExplanation
			activeAddress = { param.activeAddress }
			simulationMode = { param.simulationMode }
			signerName = { param.signerName }
			useSignersAddressAsActiveAddress = { param.useSignersAddressAsActiveAddress }
			tabIcon = { param.tabIconDetails.icon }
		/>
	</>
}

function SimulationResults(param: SimulationStateParam) {
	if (param.simulationAndVisualisationResults === undefined) return <></>
	if (param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length === 0) {
		return <div style = 'padding: 10px'> <DinoSays text = { 'Give me some transactions to munch on!' } /> </div>
	}

	return <div>
		<div style = 'display: grid; grid-template-columns: auto auto; padding-left: 10px; padding-right: 10px' >
			<div class = 'log-cell' style = 'justify-content: left;'>
				<p className = 'h1'> Simulation Results </p>
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				<button className = 'button is-small is-danger' disabled = { param.disableReset } onClick = { param.resetSimulation } >
					<span class = 'icon'>
						<img src = '../../img/broom.svg'/>
					</span>
					<span>
						Clear
					</span>
				</button>
			</div>
		</div>

		<div class = { param.simulationResultState === 'invalid' || param.simulationUpdatingState === 'failed' ? 'blur' : '' }>
			<Transactions
				simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
				removeTransaction = { param.removeTransaction }
				activeAddress = { param.simulationAndVisualisationResults.activeAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
				removeTransactionHashes = { param.removeTransactionHashes }
			/>
			{ param.removeTransactionHashes.length > 0
				? <></>
				: <SimulationSummary
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					currentBlockNumber = { param.currentBlockNumber }
					renameAddressCallBack = { param.renameAddressCallBack }
					rpcConnectionStatus = { param.rpcConnectionStatus }
				/>
			}
		</div>
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

type NetworkErrorParams = {
	rpcConnectionStatus: RpcConnectionStatus
}

export function NetworkErrors({ rpcConnectionStatus } : NetworkErrorParams) {
	if (rpcConnectionStatus === undefined) return <></>
	const priorDate = new Date(rpcConnectionStatus.lastConnnectionAttempt.getTime() + TIME_BETWEEN_BLOCKS * 1000)
	return <>
		{ rpcConnectionStatus.isConnected === false ?
			<div style = 'margin: 10px; background-color: var(--bg-color);'>
				<Error warning = { true } text = { <>Unable to connect to { rpcConnectionStatus.rpcNetwork.name }. Retrying in <SomeTimeAgo priorTimestamp = { priorDate } countBackwards = { true }/>.</> }/>
			</div>
		: <></> }

		{ rpcConnectionStatus.latestBlock !== undefined && noNewBlockForOverTwoMins(rpcConnectionStatus) ?
			<div style = 'margin: 10px; background-color: var(--bg-color);'>
				<Error warning = { true } text = { <>The connected RPC ({ rpcConnectionStatus.rpcNetwork.name }) seem to be stuck at block { rpcConnectionStatus.latestBlock.number } (occured on: { humanReadableDate(rpcConnectionStatus.latestBlock.timestamp) }). Retrying in <SomeTimeAgo priorTimestamp = { priorDate } countBackwards = { true }/>.</> }/>
			</div>
		: <></> }
	</>
}

export function Home(param: HomeParams) {
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<AddressInfo | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<AddressInfo | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined>(undefined)
	const [rpcNetwork, setSelectedNetwork] = useState<RpcNetwork | undefined>()
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const [signerAccounts, setSignerAccounts] = useState<readonly bigint[] | undefined>(undefined)
	const [isLoaded, setLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [signerName, setSignerName] = useState<SignerName>('NoSignerDetected')
	const [addressInfos, setAddressInfos] = useState<readonly AddressInfo[] | undefined>(undefined)
	const [makeMeRich, setMakeMeRich] = useState<boolean>(false)
	const [disableReset, setDisableReset] = useState<boolean>(false)
	const [removeTransactionHashes, setRemoveTransactionHashes] = useState<bigint[]>([])
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [rpcEntries, setRPCEntries] = useState<RpcEntries>([])
	const [simulationUpdatingState, setSimulationUpdatingState] = useState<SimulationUpdatingState | undefined>(undefined)
	const [simulationResultState, setSimulationResultState] = useState<SimulationResultState | undefined>(undefined)
	
	useEffect(() => {
		setSimulationAndVisualisationResults(param.simVisResults)
		setUseSignersAddressAsActiveAddress(param.useSignersAddressAsActiveAddress)
		setActiveSimulationAddress(param.activeSimulationAddress !== undefined ? findAddressInfo(param.activeSimulationAddress, param.addressInfos) : undefined)
		setActiveSigningAddress(param.activeSigningAddress !== undefined ? findAddressInfo(param.activeSigningAddress, param.addressInfos) : undefined)
		setSelectedNetwork(param.rpcNetwork)
		setSimulationMode(param.simulationMode)
		setTabConnection(param.tabIconDetails)
		setSignerAccounts(param.signerAccounts)
		setCurrentBlockNumber(param.currentBlockNumber)
		setAddressInfos(param.addressInfos)
		setSignerName(param.signerName)
		setLoaded(true)
		setMakeMeRich(param.makeMeRich)
		setDisableReset(false)
		setRemoveTransactionHashes([])
		setRpcConnectionStatus(param.rpcConnectionStatus)
		setRPCEntries(param.rpcEntries)
		setSimulationUpdatingState(param.simulationUpdatingState)
		setSimulationResultState(param.simulationResultState)
	}, [param.activeSigningAddress,
		param.activeSimulationAddress,
		param.signerAccounts,
		param.addressInfos,
		param.useSignersAddressAsActiveAddress,
		param.rpcNetwork,
		param.simulationMode,
		param.tabIconDetails,
		param.currentBlockNumber,
		param.signerName,
		param.simVisResults,
		param.rpcConnectionStatus,
		param.rpcEntries,
		param.simulationUpdatingState,
		param.simulationResultState,
	])

	function changeActiveAddress() {
		param.setAndSaveAppPage('ChangeActiveAddress')
	}

	function enableSimulationMode(enabled: boolean ) {
		sendPopupMessageToBackgroundPage( { method: 'popup_enableSimulationMode', data: enabled } )
		setSimulationMode(enabled)
	}

	function resetSimulation() {
		setDisableReset(true)
		sendPopupMessageToBackgroundPage({ method: 'popup_resetSimulation' })
	}

	async function removeTransaction(tx: SimulatedAndVisualizedTransaction) {
		setRemoveTransactionHashes((hashes) => hashes.concat(tx.transaction.hash))
		if (identifyTransaction(tx).type === 'MakeYouRichTransaction') {
			return await enableMakeMeRich(false)
		} else {
			return await sendPopupMessageToBackgroundPage({ method: 'popup_removeTransaction', data: tx.transaction.hash })
		}
	}

	if (!isLoaded) return <></>
	if (rpcNetwork === undefined) return <></>

	return <>
		{ rpcNetwork.httpsRpc === undefined ?
			<div style = 'margin: 10px; background-color: var(--bg-color);'>
				<Error text = { `${ rpcNetwork.name } is not a supported network. The Interceptors is disabled while you are using the network.` }/>
			</div>
		: <></> }

		<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>

		<FirstCard
			addressInfos = { addressInfos }
			useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
			enableSimulationMode = { enableSimulationMode }
			activeAddress = { simulationMode ? activeSimulationAddress : activeSigningAddress }
			rpcNetwork = { rpcNetwork }
			changeActiveRpc = { param.setActiveRpcAndInformAboutIt }
			simulationMode = { simulationMode }
			changeActiveAddress = { changeActiveAddress }
			makeMeRich = { makeMeRich }
			signerAccounts = { signerAccounts }
			tabIconDetails = { tabIconDetails }
			signerName = { signerName }
			renameAddressCallBack = { param.renameAddressCallBack }
			rpcEntries = { rpcEntries }
		/>

		{ simulationMode && simulationAndVisualisationResults === undefined && activeSimulationAddress !== undefined ?
			<div style = 'margin-top: 0px; margin-left: 10px; margin-right: 10px;'>
				<div class = 'vertical-center'>
					<Spinner height = '1em'/>
					<span style = 'margin-left: 0.2em' > Simulating... </span>
				</div>
			</div>
		: <></> }

		{ simulationMode && currentBlockNumber === undefined ? <div style = 'padding: 10px'> <DinoSays text = { 'Not connected to a network..' } /> </div> : <></> }
		{ !simulationMode || activeSimulationAddress === undefined || currentBlockNumber === undefined
			? <></>
			: <SimulationResults
				simulationAndVisualisationResults = { simulationAndVisualisationResults }
				removeTransaction = { removeTransaction }
				disableReset = { disableReset }
				resetSimulation = { resetSimulation }
				currentBlockNumber = { currentBlockNumber }
				renameAddressCallBack = { param.renameAddressCallBack }
				removeTransactionHashes = { removeTransactionHashes }
				rpcConnectionStatus = { rpcConnectionStatus }
				simulationUpdatingState = { simulationUpdatingState }
				simulationResultState = { simulationResultState }
			/>
		}
	</>
}
