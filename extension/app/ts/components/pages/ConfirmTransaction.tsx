import { useState, useEffect } from 'preact/hooks'
import { MessageToPopup, SignerName } from '../../utils/interceptor-messages.js'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import { ErrorCheckBox } from '../subcomponents/Error.js'
import Hint from '../subcomponents/Hint.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { Transactions } from '../simulationExplaining/Transactions.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { getSignerName, SignerLogoText } from '../subcomponents/signers.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddingNewAddressType, AddressBookEntry } from '../../utils/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { formSimulatedAndVisualizedTransaction } from '../formVisualizerResults.js'
import { addressString } from '../../utils/bigint.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'

type WebsiteOriginAndIcon = {
	websiteOrigin: string,
	websiteIcon: string | undefined,
}

export function ConfirmTransaction() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<(SimulationAndVisualisationResults & WebsiteOriginAndIcon) | undefined >(undefined)
	const [transactionToSimulate, setTransactionToSimulate] = useState<EthereumUnsignedTransaction | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [signerName, setSignerName] = useState<SignerName | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [refreshPressed, setRefreshPressed] = useState<boolean>(false)

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			const message = MessageToPopup.parse(msg)

			if (message.method === 'popup_new_block_arrived') return setCurrentBlockNumber(message.data.blockNumber)

			if (message.method !== 'popup_confirm_transaction_simulation_state_changed') return

			if (currentBlockNumber === undefined || message.data.simulationState.blockNumber > currentBlockNumber) {
				setCurrentBlockNumber(message.data.simulationState.blockNumber)
			}

			setRefreshPressed(false)
			setSignerName(message.data.signerName)
			setRequestIdToConfirm(message.data.requestId)
			const addressMetaData = new Map(message.data.addressBookEntries.map( (x) => [addressString(x.address), x]))
			const txs = formSimulatedAndVisualizedTransaction(message.data.simulationState, message.data.visualizerResults, addressMetaData)
			setTransactionToSimulate(message.data.transactionToSimulate)

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
				websiteOrigin: message.data.websiteOrigin,
				websiteIcon: message.data.websiteIcon,
			})

			console.log(message.data.websiteOrigin)
			console.log(message.data.websiteIcon)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmTransactionReadyAndListening' } )

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	const removeTransaction = (_hash: bigint) => reject()

	function approve() {
		if (requestIdToConfirm === undefined) throw new Error('request id is not set')
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: true } } )
	}

	function reject() {
		if (requestIdToConfirm === undefined) throw new Error('request id is not set')
		sendPopupMessageToBackgroundPage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: false } } )
	}

	function refreshSimulation() {
		if (simulationAndVisualisationResults === undefined || requestIdToConfirm === undefined || transactionToSimulate === undefined) return
		setRefreshPressed(true)
		sendPopupMessageToBackgroundPage( {
			method: 'popup_refreshConfirmTransactionDialogSimulation',
			data: {
				activeAddress: simulationAndVisualisationResults.activeAddress,
				simulationMode: simulationAndVisualisationResults.simulationMode,
				requestId: requestIdToConfirm,
				transactionToSimulate: transactionToSimulate,
				websiteOrigin: simulationAndVisualisationResults.websiteOrigin,
				websiteIcon: simulationAndVisualisationResults.websiteIcon,
			}
		} )
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		const success = simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].statusCode === 'success'
		const noQuarantines = simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.quarantine) === undefined
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	return (
		<main>
			{ simulationAndVisualisationResults !== undefined ?
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
					<div className = 'block' style = 'margin-bottom: 0px'>
						<div style = 'margin: 10px;'>
							<Transactions
								simulationAndVisualisationResults = { simulationAndVisualisationResults }
								removeTransaction = { removeTransaction }
								showOnlyOneAndAggregateRest = { true }
								activeAddress = { simulationAndVisualisationResults.activeAddress }
								renameAddressCallBack = { renameAddressCallBack }
							/>
							<SimulationSummary
								simulationAndVisualisationResults = { simulationAndVisualisationResults }
								summarizeOnlyLastTransaction = { true }
								resetButton = { false }
								refreshSimulation = { refreshSimulation }
								currentBlockNumber = { currentBlockNumber }
								renameAddressCallBack = { renameAddressCallBack }
								refreshPressed = { refreshPressed }
							/>
							<div className = 'block' style = 'margin: 10px; padding: 10px; background-color: var(--card-bg-color);'>
								{ simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].statusCode === 'success' ? <></> :
									<div class = 'card-content'>
										<ErrorCheckBox text = { 'I understand that the transaction will most likely fail but I want to send it anyway.' } checked = { forceSend } onInput = { setForceSend } />
									</div>
								}
								{ simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].quarantine !== true ? <></> :
									<div class = 'card-content'>
										<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
									</div>
								}
								<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
									<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { approve } disabled = { isConfirmDisabled() }>
										{ simulationAndVisualisationResults.simulationMode ? 'Simulate!' :
											<SignerLogoText {...{
												signerName,
												text: `Sign with ${ getSignerName(signerName) }`
											}} />
										}
									</button>
									<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
										Reject
									</button>
								</div>
							</div>
						</div>
					</div>
					<div class = 'content' style = 'height: 0.1px'/>
				</Hint>
			:
				<div class = 'center-to-page'>
					<div class = 'vertical-center' style = 'scale: 3'>
						<Spinner/>
						<span style = 'margin-left: 0.2em' > Simulating... </span>
					</div>
				</div>
			}
		</main>
	)
}
