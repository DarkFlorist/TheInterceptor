import { HomeParams, AddressInfo, Page, FirstCardParams } from '../../utils/user-interface-types'
import { useEffect, useState } from 'preact/hooks'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types'
import { EthereumQuantity } from '../../utils/wire-types'
import { ActiveAddress, findAddressInfo } from '../subcomponents/address'
import { SimulationResults } from '../simulationExplaining/SimulationSummary'
import { ChainSelector } from '../subcomponents/ChainSelector'
import { Spinner } from '../subcomponents/Spinner'
import { getChainName, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, isSupportedChain } from '../../utils/constants'
import { SignerName } from '../../utils/interceptor-messages'
import { getSignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers'
import { Error } from '../subcomponents/Error'

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
						<img src = { param.tabIcon } />
					</span>
				</div>
				<div class = 'card-header-title'>
					<input type = 'checkbox' id = 'toggle' style = 'display: none;' checked = { !param.simulationMode } class = 'toggleCheckbox' onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { param.enableSimulationMode(!e.target.checked) } } } />
					<label for = 'toggle' class = 'toggleContainer'>
						<div style = 'font-weight: normal' >Simulating</div>
						<div style = 'font-weight: normal;' >
							<SignerLogoText
								signerName = { param.signerName }
								text = { 'Signing' }
							/>
						</div>
					</label>
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
						{ param.signerAccounts !== undefined && param.signerAccounts.length > 0 && param.tabIcon !== ICON_NOT_ACTIVE ? <span style = 'float: right; color: var(--primary-color);'> CONNECTED </span> :
							param.tabIcon === ICON_SIGNING || param.tabIcon === ICON_SIGNING_NOT_SUPPORTED ? <span style = 'float: right; color: var(--negative-color);'> NOT CONNECTED </span> : <></>
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

					( (param.signerAccounts === undefined || param.signerAccounts.length == 0) && param.tabIcon !== ICON_NOT_ACTIVE ) ?
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
	const [tabIcon, setTabIcon] = useState<string>( ICON_NOT_ACTIVE )
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
		setTabIcon(param.tabIcon)
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
		param.tabIcon,
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
						tabIcon = { tabIcon }
						tabApproved = { tabApproved }
						signerName = { signerName }
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
				/>
			}
		</div>
	)
}
