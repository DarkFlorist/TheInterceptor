import { HomeParams, AddressInfo, FirstCardParams, SimulationStateParam } from '../../utils/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import { ActiveAddress, findAddressInfo } from '../subcomponents/address.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { DEFAULT_TAB_CONNECTION, getChainName, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, isSupportedChain } from '../../utils/constants.js'
import { SignerName, TabIconDetails } from '../../utils/interceptor-messages.js'
import { getSignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { Error } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { Transactions } from '../simulationExplaining/Transactions.js'
import { DinoSays } from '../subcomponents/DinoSays.js'

function FirstCard(param: FirstCardParams) {
	async function enableMakeMeRich(enabled: boolean) {
		sendPopupMessageToBackgroundPage( { method: 'popup_changeMakeMeRich', options: enabled } )
	}

	function connectToSigner() {
		sendPopupMessageToBackgroundPage( { method: 'popup_requestAccountsFromSigner', options: true } )
	}

	return <div class = 'card' style = 'margin: 10px;'>
		<header class = 'card-header'>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon' style = 'height: 3rem; width: 3rem;'>
					<ToolTip content = {  param.tabIconDetails.iconReason }>
						<img className = 'noselect nopointer' src = { param.tabIconDetails.icon } />
					</ToolTip>
				</span>
			</div>
			<div class = 'card-header-title px-0 is-justify-content-center'>
				<div class = 'buttons has-addons' style = 'border-style: solid; border-color: var(--primary-color); border-radius: 4px; padding: 1px; border-width: 1px; margin-bottom: 0px' >
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
				<ChainSelector currentChain = { param.activeChain } changeChain = { (chainId: bigint) => { param.changeActiveChain(chainId) } }/>
			</div>

		</header>
		<div class = 'card-content'>
			{ param.useSignersAddressAsActiveAddress || !param.simulationMode ?
				<p style = 'color: var(--text-color); text-align: left'>
					<span class = 'vertical-center' style = 'display: inline-flex;' >
						Retrieving from&nbsp;
						<SignersLogoName signerName = { param.signerName } />
					</span>
					{ param.signerAccounts !== undefined && param.signerAccounts.length > 0 && param.tabIconDetails.icon !== ICON_NOT_ACTIVE ? <span style = 'float: right; color: var(--primary-color);'> CONNECTED </span> :
						param.tabIconDetails.icon === ICON_SIGNING || param.tabIconDetails.icon === ICON_SIGNING_NOT_SUPPORTED ? <span style = 'float: right; color: var(--negative-color);'> NOT CONNECTED </span> : <></>
					}
				</p>
				: <></>
			}
			{ param.activeAddress !== undefined ?
				<ActiveAddress
					activeAddress = { {
						type: 'addressInfo' as const,
						...param.activeAddress,
					} }
					buttonText = { 'Change' }
					disableButton = { !param.simulationMode }
					changeActiveAddress = { param.changeActiveAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			: param.useSignersAddressAsActiveAddress || !param.simulationMode ?
				<div class = 'content' style = 'color: var(--negative-color)'>
					{ `No active address found in ${ getSignerName(param.signerName) }` }
				</div>
			:
				<div class = 'content' style = 'color: var(--negative-color)'>
					No active address
				</div>
			}
			{ !param.simulationMode ?
				( (param.signerAccounts === undefined || param.signerAccounts.length == 0) && param.tabIconDetails.icon !== ICON_NOT_ACTIVE ) ?
					<div style = 'margin-top: 5px'>
						<button className = 'button is-primary' onClick = { connectToSigner } >
							<SignerLogoText
								signerName = { param.signerName }
								text = { `Connect to ${ getSignerName(param.signerName) }` }
							/>
						</button>
					</div>
				: <p style = 'color: var(--subtitle-text-color);' class = 'subtitle is-7'> { ` You can change active address by changing it directly from ${ getSignerName(param.signerName) }` } </p>
			:
				<label class = 'form-control' style = 'padding-top: 10px'>
					<input type = 'checkbox' checked = { param.makeMeRich } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeMeRich(e.target.checked) } } } />
					<p class = 'paragraph checkbox-text'>Make me rich</p>
				</label>
			}
		</div>
	</div>
}

function SimulationResults(param: SimulationStateParam) {
	if (param.simulationAndVisualisationResults === undefined) return <></>
	if (param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length === 0) {
		return <div style = 'padding: 10px'> <DinoSays text = { 'Give me some transactions to munch on!' } /> </div>
	}

	return <div>
		<p className = 'h1' style = 'padding-left: 10px'> Simulation Results </p>

		<Transactions
			simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
			removeTransaction = { param.removeTransaction }
			activeAddress = { param.simulationAndVisualisationResults.activeAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<SimulationSummary
			simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
			resetButton = { true }
			refreshSimulation =  { param.refreshSimulation }
			currentBlockNumber = { param.currentBlockNumber }
			renameAddressCallBack = { param.renameAddressCallBack }
			refreshPressed = { param.refreshPressed }
		/>
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

export function Home(param: HomeParams) {
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<AddressInfo | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<AddressInfo | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined>(undefined)
	const [activeChain, setActiveChain] = useState<bigint>(1n)
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [tabIconDetails, setTabConnection] = useState<TabIconDetails>( DEFAULT_TAB_CONNECTION )
	const [signerAccounts, setSignerAccounts] = useState<readonly bigint[] | undefined>(undefined)
	const [isLoaded, setLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [signerName, setSignerName] = useState<SignerName | undefined> (undefined)
	const [refreshPressed, setRefreshPressed] = useState<boolean> (false)

	useEffect( () => {
		setSimulationAndVisualisationResults(param.simVisResults)
		setRefreshPressed(false)
	}, [param.simVisResults])

	useEffect( () => {
		setUseSignersAddressAsActiveAddress(param.useSignersAddressAsActiveAddress)
		setActiveSimulationAddress(param.activeSimulationAddress !== undefined ? findAddressInfo(param.activeSimulationAddress, param.addressInfos) : undefined)
		setActiveSigningAddress(param.activeSigningAddress !== undefined ? findAddressInfo(param.activeSigningAddress, param.addressInfos) : undefined)
		setActiveChain(param.activeChain)
		setSimulationMode(param.simulationMode)
		setTabConnection(param.tabIconDetails)
		setSignerAccounts(param.signerAccounts)
		setCurrentBlockNumber(param.currentBlockNumber)
		setSignerName(param.signerName)
		setLoaded(true)
	}, [param.activeSigningAddress,
		param.activeSimulationAddress,
		param.signerAccounts,
		param.addressInfos,
		param.useSignersAddressAsActiveAddress,
		param.activeChain,
		param.simulationMode,
		param.tabIconDetails,
		param.currentBlockNumber,
		param.signerName,
	])

	function changeActiveAddress() {
		param.setAndSaveAppPage('ChangeActiveAddress')
	}

	function enableSimulationMode(enabled: boolean ) {
		sendPopupMessageToBackgroundPage( { method: 'popup_enableSimulationMode', options: enabled } )
		setSimulationMode(enabled)
	}

	function removeTransaction(hash: bigint) {
		sendPopupMessageToBackgroundPage( { method: 'popup_removeTransaction', options: hash } )
	}

	function refreshSimulation() {
		setRefreshPressed(true)
		sendPopupMessageToBackgroundPage( { method: 'popup_refreshSimulation' } )
	}

	if (!isLoaded) return <></>

	return <>
		{ !isSupportedChain(param.activeChain.toString()) ?
			<div style = 'margin: 10px; background-color: var(--bg-color);'>
				<Error text = { `${ getChainName(param.activeChain) } is not a supported network. The Interceptor is disabled while you are using the network.` }/>
			</div>
		: <></> }

		<FirstCard
			addressInfos = { param.addressInfos }
			useSignersAddressAsActiveAddress = { useSignersAddressAsActiveAddress }
			enableSimulationMode = { enableSimulationMode }
			activeAddress = { simulationMode ? activeSimulationAddress : activeSigningAddress }
			activeChain = { activeChain }
			changeActiveChain = { param.setActiveChainAndInformAboutIt }
			simulationMode = { simulationMode }
			changeActiveAddress = { changeActiveAddress }
			makeMeRich = { param.makeMeRich }
			signerAccounts = { signerAccounts }
			tabIconDetails = { tabIconDetails }
			signerName = { signerName }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>

		{ simulationMode && simulationAndVisualisationResults === undefined && activeSimulationAddress !== undefined ?
			<div style = 'margin-top: 0px; margin-left: 10px; margin-right: 10px;'>
				<div class = 'vertical-center'>
					<Spinner/>
					<span style = 'margin-left: 0.2em' > Simulating... </span>
				</div>
			</div>
		: <></> }

		{ !simulationMode || activeSimulationAddress === undefined ? <></> :
			<SimulationResults
				simulationAndVisualisationResults = { simulationAndVisualisationResults }
				removeTransaction = { removeTransaction }
				refreshSimulation = { refreshSimulation }
				currentBlockNumber = { currentBlockNumber }
				renameAddressCallBack = { param.renameAddressCallBack }
				refreshPressed = { refreshPressed }
			/>
		}
	</>
}
