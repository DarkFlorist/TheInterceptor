import { useState, useEffect } from 'preact/hooks'
import { SignerName } from '../../utils/interceptor-messages.js'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import { ErrorCheckBox } from '../subcomponents/Error.js'
import Hint from '../subcomponents/Hint.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { Transactions } from '../simulationExplaining/Transactions.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { getSignerName, SignerLogoText } from '../subcomponents/signers.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import { formSimulatedAndVisualizedTransaction } from '../formVisualizerResults.js'

export function ConfirmTransaction() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined >(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [signerName, setSignerName] = useState<SignerName | undefined>(undefined)
	const [isEditAddressModelOpen, setEditAddressModelOpen] = useState<boolean>(false)
	const [addressBookEntryInput, setAddressBookEntryInput] = useState<AddressBookEntry | undefined>(undefined)

	useEffect( () => {
		const updateTx = async () => {
			const backgroundPage = await browser.runtime.getBackgroundPage()
			if( !('confirmTransactionDialog' in backgroundPage.interceptor) || backgroundPage.interceptor.confirmTransactionDialog === undefined) return window.close();
			setRequestIdToConfirm(backgroundPage.interceptor.confirmTransactionDialog.requestId)
			await fetchSimulationState()
		}
		function popupMessageListener(msg: unknown) {
			console.log('popup message')
			console.log(msg)
			fetchSimulationState()
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		updateTx()

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	async function fetchSimulationState() {
		const backgroundPage = await browser.runtime.getBackgroundPage()
		setSignerName(backgroundPage.interceptor.signerName)
		const dialog = backgroundPage.interceptor.confirmTransactionDialog
		if (dialog === undefined || dialog.simulationState === undefined || dialog.visualizerResults === undefined) return setSimulationAndVisualisationResults(undefined)

		const simState = dialog.simulationState
		setCurrentBlockNumber(backgroundPage.interceptor.currentBlockNumber)

		const addressMetaData = new Map(dialog.addressBookEntries.map( (x) => [x[0], x[1]]))
		const txs = formSimulatedAndVisualizedTransaction(simState, dialog.visualizerResults, addressMetaData)
		setSimulationAndVisualisationResults( {
			blockNumber: simState.blockNumber,
			blockTimestamp: simState.blockTimestamp,
			simulationConductedTimestamp: simState.simulationConductedTimestamp,
			simulatedAndVisualizedTransactions: txs,
			chain: simState.chain,
			tokenPrices: dialog.tokenPrices,
			activeAddress: dialog.activeAddress,
			simulationMode: dialog.simulationMode,
			isComputingSimulation: dialog.isComputingSimulation,
			addressMetaData: addressMetaData,
		})
	}

	const removeTransaction = (_hash: bigint) => reject()

	function approve() {
		browser.runtime.sendMessage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: true } } )
	}

	function reject() {
		browser.runtime.sendMessage( { method: 'popup_confirmDialog', options: { requestId: requestIdToConfirm, accept: false } } )
	}

	function refreshSimulation() {
		browser.runtime.sendMessage( { method: 'popup_refreshConfirmTransactionDialogSimulation' } );
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		const success = simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions[simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ].statusCode === 'success'
		const noQuarantines = simulationAndVisualisationResults && simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.quarantine) === undefined
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setEditAddressModelOpen(true)
		setAddressBookEntryInput(entry)
	}

	return (
		<main>
			{ simulationAndVisualisationResults !== undefined ?
				<Hint>
					<div class = { `modal ${ isEditAddressModelOpen? 'is-active' : ''}` }>
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addressBookEntry = { addressBookEntryInput }
							setAddressBookEntryInput = { setAddressBookEntryInput }
							addingNewAddress = { false }
							close = { () => { setEditAddressModelOpen(false) } }
							activeAddress = { undefined }
						/>
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
