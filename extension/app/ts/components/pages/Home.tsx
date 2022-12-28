import { HomeParams, AddressInfo, Page, FirstCardParams, TabConnection } from '../../utils/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import { EthereumQuantity } from '../../utils/wire-types.js'
import { ActiveAddress, findAddressInfo } from '../subcomponents/address.js'
import { SimulationResults } from '../simulationExplaining/SimulationSummary.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { DEFAULT_TAB_CONNECTION, getChainName, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, isSupportedChain } from '../../utils/constants.js'
import { SignerName } from '../../utils/interceptor-messages.js'
import { getSignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { Error } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'

function FirstCard(param: FirstCardParams) {
	async function enableMakeMeRich(enabled: boolean) {
		browser.runtime.sendMessage( { method: 'popup_changeMakeMeRich', options: enabled } );
	}

	function connectToSigner() {
		browser.runtime.sendMessage( { method: 'popup_requestAccountsFromSigner', options: true } );
	}

	return <>
		{ !isSupportedChain(param.activeChain.toString()) ?
			<div style = 'padding-bottom: 10px; background-color: var(--bg-color);'>
				<Error text = { `${ getChainName(param.activeChain) } is not a supported network. The Interceptor is disabled while you are using the network.` }/>
			</div>
		: <></> }

		<div class = 'block' style = 'background-color: var(--card-bg-color); margin-bottom: 0px;'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon' style = 'height: 3rem; width: 3rem;'>
						<ToolTip content = {  param.tabConnection.iconReason }>
							<img className = 'noselect nopointer' src = { param.tabConnection.icon } />
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
						{ param.signerAccounts !== undefined && param.signerAccounts.length > 0 && param.tabConnection.icon !== ICON_NOT_ACTIVE ? <span style = 'float: right; color: var(--primary-color);'> CONNECTED </span> :
							param.tabConnection.icon === ICON_SIGNING || param.tabConnection.icon === ICON_SIGNING_NOT_SUPPORTED ? <span style = 'float: right; color: var(--negative-color);'> NOT CONNECTED </span> : <></>
						}
					</p>
					: <></>
				}
				{ param.activeAddress !== undefined ?
					<ActiveAddress
						address = { param.activeAddress.address }
						title = { param.activeAddress.name }
						simulationMode = { param.simulationMode }
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

					( (param.signerAccounts === undefined || param.signerAccounts.length == 0) && param.tabConnection.icon !== ICON_NOT_ACTIVE ) ?
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
					<label class = 'form-control'>
						<input type = 'checkbox' checked = { param.makeMeRich } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeMeRich(e.target.checked) } } } />
						Make me rich
					</label>
				}
			</div>
		</div>
	</>
}
export function Home(param: HomeParams) {
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<AddressInfo | undefined>(undefined)
	const [activeSigningAddress, setActiveSigningAddress] = useState<AddressInfo | undefined>(undefined)
	const [useSignersAddressAsActiveAddress, setUseSignersAddressAsActiveAddress] = useState(false)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined>(undefined)
	const [activeChain, setActiveChain] = useState<bigint>(1n)
	const [simulationMode, setSimulationMode] = useState<boolean>(true)
	const [tabConnection, setTabConnection] = useState<TabConnection>( DEFAULT_TAB_CONNECTION )
	const [tabApproved, setTabApproved] = useState<boolean>(false)
	const [signerAccounts, setSignerAccounts] = useState<readonly bigint[] | undefined>(undefined)
	const [isLoaded, setLoaded] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<bigint | undefined>(undefined)
	const [signerName, setSignerName]= useState<SignerName | undefined> (undefined)

	useEffect( () => {
		setSimulationAndVisualisationResults(param.simVisResults)
	}, [param.simVisResults])

	useEffect( () => {
		setUseSignersAddressAsActiveAddress(param.useSignersAddressAsActiveAddress)
		setActiveSimulationAddress(param.activeSimulationAddress !== undefined ? findAddressInfo(param.activeSimulationAddress, param.addressInfos) : undefined)
		setActiveSigningAddress(param.activeSigningAddress !== undefined ? findAddressInfo(param.activeSigningAddress, param.addressInfos) : undefined)
		setActiveChain(param.activeChain)
		setSimulationMode(param.simulationMode)
		setTabApproved(param.tabApproved)
		setTabConnection(param.tabConnection)
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
		param.tabConnection,
		param.tabApproved,
		param.currentBlockNumber,
		param.signerName,
	])

	function changeActiveAddress() {
		param.setAndSaveAppPage(Page.ChangeActiveAddress)
	}

	function enableSimulationMode(enabled: boolean ) {
		browser.runtime.sendMessage( { method: 'popup_enableSimulationMode', options: enabled } );
		setSimulationMode(enabled)
	}

	function removeTransaction(hash: bigint) {
		browser.runtime.sendMessage( { method: 'popup_removeTransaction', options: EthereumQuantity.serialize(hash) } );
	}

	function refreshSimulation() {
		browser.runtime.sendMessage( { method: 'popup_refreshSimulation' } );
	}

	if (!isLoaded) return <></>

	return (
		<div className = 'block' style = 'margin-bottom: 0px' >
			<div style = 'margin: 10px;'>
				<div class = 'block' style = 'background-color: var(--card-content-bg-color)'>
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
						tabConnection = { tabConnection }
						tabApproved = { tabApproved }
						signerName = { signerName }
						renameAddressCallBack = { param.addOrModifyAddress }
					/>
				</div>
			</div>

			{ simulationMode && simulationAndVisualisationResults === undefined ?
				<div style = 'margin-top: 0px; margin-left: 10px; margin-right: 10px;'>
					<div class = 'vertical-center'>
						<Spinner/>
						<span style = 'margin-left: 0.2em' > Simulating... </span>
					</div>
				</div>
			: <></> }

			{ !simulationMode || activeSimulationAddress === undefined ? <></> :
				<SimulationResults
					addressMetadata = { param.simVisResults !== undefined ? param.simVisResults.addressMetadata : new Map() }
					simulationAndVisualisationResults = { simulationAndVisualisationResults }
					removeTransaction = { removeTransaction }
					refreshSimulation = { refreshSimulation }
					currentBlockNumber = { currentBlockNumber }
					renameAddressCallBack = { param.addOrModifyAddress }
				/>
			}
		</div>
	)
}
