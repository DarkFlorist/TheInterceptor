import { useState, useEffect } from 'preact/hooks'
import { ExternalPopupMessage, SignerName } from '../../utils/interceptor-messages.js'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { GasFee, LogAnalysisCard, SimulatedInBlockNumber, TransactionHeader, TransactionsAccountChangesCard } from '../simulationExplaining/SimulationSummary.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddingNewAddressType, AddressBookEntry, Website } from '../../utils/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { formSimulatedAndVisualizedTransaction } from '../formVisualizerResults.js'
import { addressString } from '../../utils/bigint.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { ErrorCheckBox } from '../subcomponents/Error.js'
import { QuarantineCodes, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'

type TransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	resetButton: boolean,
	currentBlockNumber: bigint | undefined,
}

function TransactionCard(param: TransactionCardParams) {
	const tx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
	if (tx === undefined) return <></>

	return <>
		<div class = 'block' style = 'margin: 10px; margin-top: 10px; margin-bottom: 10px;'>
			<nav class = 'breadcrumb has-succeeds-separator is-small'>
				<ul>
					{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map((tx, index) => (
						<li style = 'margin: 0px;'>
							<div class = 'card' style = { `padding: 5px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
								<p class = 'paragraph' style = {`margin: 0px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
									{ identifyTransaction(tx, param.activeAddress).title }
								</p>
							</div>
						</li>
					)) }
				</ul>
			</nav>
		</div>

		<div class = 'card' style = 'margin: 10px;'>
			<TransactionHeader
				tx = { tx }
				renameAddressCallBack = { param.renameAddressCallBack }
				activeAddress = { param.activeAddress }
			/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						tx = { tx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
					<QuarantineCodes tx = { tx }/>
				</div>

				<TransactionsAccountChangesCard
					tx = { tx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { param.simulationAndVisualisationResults.addressMetaData }
				/>

				<LogAnalysisCard
					tx = { tx }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: min-content min-content min-content auto;'>
					<GasFee
						tx = { tx }
						chain = { param.simulationAndVisualisationResults.chain }
					/>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { param.simulationAndVisualisationResults.blockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }
						/>
					</div>
				</span>
			</div>
		</div>
	</>
}

export function ConfirmTransaction() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults & ({ website: Website }) | undefined >(undefined)
	const [transactionToSimulate, setTransactionToSimulate] = useState<EthereumUnsignedTransaction | undefined>(undefined)
	const [sender, setSender] = useState<AddressBookEntry | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [signerName, setSignerName] = useState<SignerName | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)

			if (message.method === 'popup_new_block_arrived') {
				refreshSimulation()
				return setCurrentBlockNumber(message.data.blockNumber)
			}

			if (message.method !== 'popup_confirm_transaction_simulation_state_changed') return

			if (currentBlockNumber === undefined || message.data.simulationState.blockNumber > currentBlockNumber) {
				setCurrentBlockNumber(message.data.simulationState.blockNumber)
			}

			setSignerName(message.data.signerName)
			setRequestIdToConfirm(message.data.requestId)
			const addressMetaData = new Map(message.data.addressBookEntries.map( (x) => [addressString(x.address), x]))
			const txs = formSimulatedAndVisualizedTransaction(message.data.simulationState, message.data.visualizerResults, addressMetaData)
			setTransactionToSimulate(message.data.transactionToSimulate)
			setSender(txs.at(-1)?.from)

			setSimulationAndVisualisationResults( {
				blockNumber: message.data.simulationState.blockNumber,
				blockTimestamp: message.data.simulationState.blockTimestamp,
				simulationConductedTimestamp: message.data.simulationState.simulationConductedTimestamp,
				simulatedAndVisualizedTransactions: txs,
				chain: message.data.simulationState.chain,
				tokenPrices: message.data.tokenPrices,
				activeAddress: message.data.activeAddress,
				simulationMode: message.data.simulationMode,
				addressMetaData: message.data.addressBookEntries,
				website: message.data.website,
			})
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect( () => {
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmTransactionReadyAndListening' } )
	}, [])

	function approve() {
		if (requestIdToConfirm === undefined) throw new Error('request id is not set')
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: true } } )
	}
	function reject() {
		if (requestIdToConfirm === undefined) throw new Error('request id is not set')
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: false } } )
	}
	const refreshSimulation = () => {
		if (simulationAndVisualisationResults === undefined || requestIdToConfirm === undefined || transactionToSimulate === undefined) return
		sendPopupMessageToBackgroundPage( {
			method: 'popup_refreshConfirmTransactionDialogSimulation',
			data: {
				activeAddress: simulationAndVisualisationResults.activeAddress,
				simulationMode: simulationAndVisualisationResults.simulationMode,
				requestId: requestIdToConfirm,
				transactionToSimulate: transactionToSimulate,
				website: simulationAndVisualisationResults.website,
			}
		} )
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		if (simulationAndVisualisationResults === undefined) return false
		const lastTx = simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ]
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine == false
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function Buttons() {
		if (simulationAndVisualisationResults === undefined) return <></>
		const tx = simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
		if (tx === undefined) return <></>
		const identified = identifyTransaction(tx, simulationAndVisualisationResults.activeAddress)

		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary button-overflow' style = 'flex-grow: 1; margin-left: 10px; margin-right: 5px; margin-top: 0px; margin-bottom: 0px;' onClick = { approve } disabled = { isConfirmDisabled() }>
				{ simulationAndVisualisationResults.simulationMode ? `${ identified.simulationAction }!` :
					<SignerLogoText {...{
						signerName,
						text: identified.signingAction,
					}}/>
				}
			</button>
			<button className = 'button is-primary is-danger button-overflow' style = 'flex-grow: 1; margin-left: 5px; margin-right: 10px; margin-top: 0px; margin-bottom: 0px;' onClick = { reject} >
				{ identified.rejectAction }
			</button>
		</div>
	}

	if (simulationAndVisualisationResults === undefined) {
		return <main class = 'center-to-page'>
			<div class = 'vertical-center' style = 'scale: 3'>
				<Spinner/>
				<span style = 'margin-left: 0.2em' > Simulating... </span>
			</div>
		</main>
	}

	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed' ? <></> :
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addingNewAddress = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
					<div style = 'overflow-y: auto'>
						<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
							<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden; padding: 0px;'>
								<WebsiteOriginText { ...simulationAndVisualisationResults.website } />
							</div>
							<p class = 'card-header-title' style = 'overflow: hidden; font-weight: unset; flex-direction: row-reverse;'>
								{ sender === undefined ? <></> : <SmallAddress
									addressBookEntry = { sender }
									renameAddressCallBack = { renameAddressCallBack }
								/> }
							</p>
						</header>

						<TransactionCard
							simulationAndVisualisationResults = { simulationAndVisualisationResults }
							renameAddressCallBack = { renameAddressCallBack }
							activeAddress = { simulationAndVisualisationResults.activeAddress }
							resetButton = { false }
							currentBlockNumber = { currentBlockNumber }
						/>
					</div>

					<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
						{ simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].statusCode === 'success' ?
							simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].quarantine !== true ? <></> :
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
						:
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
						}
						<Buttons/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
