import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenVisualizerResultWithMetadata, TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { SmallAddress } from '../subcomponents/address.js'
import { TokenSymbol, TokenAmount, Token721AmountField } from '../subcomponents/coins.js'
import { AddressBookEntry, LogAnalysisParams, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { QUARANTINE_CODE, QUARANTINE_CODES_DICT } from '../../simulation/protectors/quarantine-codes.js'
import { Error as ErrorComponent } from '../subcomponents/Error.js'
import { identifyRoutes, identifySwap, SwapVisualization } from './SwapTransactions.js'
import { RawTransactionDetailsCard, GasFee, LogAnalysisCard, TransactionCreated, TransactionHeader } from './SimulationSummary.js'
import { identifyTransaction } from './identifyTransaction.js'
import { makeYouRichTransaction } from './customExplainers/MakeMeRich.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import { EtherTransferVisualisation, SimpleTokenTransferVisualisation } from './customExplainers/SimpleSendVisualisations.js'
import { SimpleTokenApprovalVisualisation } from './customExplainers/SimpleTokenApprovalVisualisation.js'
import { assertNever } from '../../utils/typescript.js'
import { CatchAllVisualizer } from './customExplainers/CatchAllVisualizer.js'

function isPositiveEvent(visResult: TokenVisualizerResultWithMetadata, ourAddressInReferenceFrame: bigint) {
	if (visResult.type === 'Token') {
		if (!visResult.isApproval) {
			return visResult.amount >= 0 // simple transfer
		}
		return visResult.amount === 0n // zero is only positive approve event
	}

	// nfts
	if (visResult.type === 'NFT All approval') { // all approval is only positive if someone all approves us, or all approval is removed from us
		return (visResult.allApprovalAdded && visResult.to.address === ourAddressInReferenceFrame) || (!visResult.allApprovalAdded && visResult.from.address === ourAddressInReferenceFrame)
	}

	if (visResult.isApproval) {
		return visResult.to.address === ourAddressInReferenceFrame // approval is only positive if we are getting approved
	}

	return visResult.to.address === ourAddressInReferenceFrame // send is positive if we are receiving
}

export function QuarantineCodes({ quarantineCodes }: { quarantineCodes: readonly QUARANTINE_CODE[] }) {
	return <> {
		quarantineCodes.map((code) => (
			<div style = 'margin-top: 10px;margin-bottom: 10px'>
				<ErrorComponent text = { QUARANTINE_CODES_DICT[code].label } />
			</div>
		))
	} </>
}

export type TransactionImportanceBlockParams = {
	simTx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: RenameAddressCallBack,
}

// showcases the most important things the transaction does
export function TransactionImportanceBlock(param: TransactionImportanceBlockParams) {
	if ( param.simTx.statusCode === 'failure') {
		return <div>
			<ErrorComponent text = { `The transaction fails with an error '${ param.simTx.error }'` } />
		</div>
	}
	const transactionIdentification = identifyTransaction(param.simTx)
	switch (transactionIdentification.type) {
		case 'EtherTransfer': {
			return <EtherTransferVisualisation
				simTx = { transactionIdentification.identifiedTransaction }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		}
		case 'SimpleTokenTransfer': {
			return <SimpleTokenTransferVisualisation
				simTx = { transactionIdentification.identifiedTransaction }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		}
		case 'SimpleTokenApproval': {
			return <SimpleTokenApprovalVisualisation
				approval = { transactionIdentification.identifiedTransaction.tokenResults[0] }
				transactionGasses = { transactionIdentification.identifiedTransaction }
				chainId = { transactionIdentification.identifiedTransaction.transaction.chainId }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		}
		case 'Swap': {
			const identifiedSwap = identifySwap(param.simTx)
			if (identifiedSwap === undefined) throw new Error('Not a swap!')
			return <SwapVisualization
				identifiedSwap = { identifiedSwap }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
		}
		case 'MakeYouRichTransaction': return makeYouRichTransaction(param)
		case 'ContractDeployment':
		case 'ContractFallbackMethod':
		case 'ArbitaryContractExecution': return <CatchAllVisualizer { ...param } />
		default: assertNever(transactionIdentification)
	}
}

export function SenderReceiver({ from, to, renameAddressCallBack }: { from: AddressBookEntry, to: AddressBookEntry | undefined, renameAddressCallBack: (entry: AddressBookEntry) => void, }) {
	const textColor = 'var(--text-color)'
	if (to === undefined) {
		return <span class = 'log-table' style = 'margin-top: 10px; column-gap: 5px; justify-content: space-between; grid-template-columns: auto auto'>
			<div class = 'log-cell' style = ''>
				<p style = { `color: var(--subtitle-text-color);` }> Transaction sender: </p>
			</div>
			<div class = 'log-cell' style = ''>
				<SmallAddress
					addressBookEntry = { from }
					textColor = { 'var(--subtitle-text-color)' }
					renameAddressCallBack = { renameAddressCallBack }
				/>
			</div>
		</span>
	}
	return <span class = 'log-table' style = 'justify-content: space-between; column-gap: 5px; grid-template-columns: auto auto auto;'>
		<div class = 'log-cell' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { from }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em; justify-content: center;'>
			<ArrowIcon color = { textColor } />
		</div>
		<div class = 'log-cell' style = 'margin: 2px; justify-content: end;'>
			<SmallAddress
				addressBookEntry = { to }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
	</span>
}

export function Transaction(param: TransactionVisualizationParameters) {
	const identifiedTransaction = identifyTransaction(param.simTx).type
	return (
		<div class = 'card'>
			<TransactionHeader
				simTx = { param.simTx }
				removeTransaction = { () => param.removeTransaction(param.simTx) }
			/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock { ...param }/>
					<QuarantineCodes quarantineCodes = { param.simTx.quarantineCodes }/>
				</div>
				{ identifiedTransaction === 'MakeYouRichTransaction' ? <></> :<>
					<LogAnalysisCard
						simTx = { param.simTx }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
					<RawTransactionDetailsCard transaction = { param.simTx.transaction } renameAddressCallBack = { param.renameAddressCallBack } gasSpent = { param.simTx.gasSpent } />

					<SenderReceiver
						from = { param.simTx.transaction.from }
						to = { param.simTx.transaction.to }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>

					<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
						<div class = 'log-cell'>
							<TransactionCreated transactionCreated = { param.simTx.transactionCreated } />
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<GasFee tx = { param.simTx } chain = { param.simulationAndVisualisationResults.chain } />
						</div>
					</span>
				</> }
			</div>
		</div>
	)
}

type TransactionsParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (tx: SimulatedAndVisualizedTransaction) => void,
	activeAddress: bigint,
	renameAddressCallBack: RenameAddressCallBack,
	removeTransactionHashes: bigint[],
}

export function Transactions(param: TransactionsParams) {
	return <ul>
		{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.filter((tx) => !param.removeTransactionHashes.includes(tx.transaction.hash)).map((simTx, _index) => (
			<li>
				<Transaction
					simTx = { simTx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					removeTransaction = { param.removeTransaction }
					activeAddress = { param.activeAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</li>
		)) }
	</ul>
}

type TokenLogEventParams = {
	tokenVisualizerResult: TokenVisualizerResultWithMetadata
	ourAddressInReferenceFrame: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

export function TokenLogEvent(params: TokenLogEventParams ) {
	const textColor = isPositiveEvent(params.tokenVisualizerResult, params.ourAddressInReferenceFrame) ? 'var(--dim-text-color)' : 'var(--negative-dim-color)'

	return <>
		<div class = 'log-cell' style = 'justify-content: right;'>
			{ params.tokenVisualizerResult.type !== 'Token' ?
				<Token721AmountField
					{ ...params.tokenVisualizerResult }
					textColor = { textColor }
				/>
			: <> { params.tokenVisualizerResult.amount >= (2n ** 96n - 1n ) && params.tokenVisualizerResult.isApproval ?
					<p class = 'ellipsis' style = { `color: ${ textColor }` }><b>ALL</b></p>
				:
					<TokenAmount
						amount = { params.tokenVisualizerResult.amount }
						decimals = { params.tokenVisualizerResult.token.decimals }
						textColor = { textColor }
					/>
				} </>
			}
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em'>
			<TokenSymbol
				{ ...params.tokenVisualizerResult.token }
				textColor = { textColor }
				useFullTokenName = { false }
			/>
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.from }
				textColor = { textColor }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			{ params.tokenVisualizerResult.isApproval ? <ApproveIcon color = { textColor } /> : <ArrowIcon color = { textColor } /> }
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.to }
				textColor = { textColor }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
	</>
}

export function LogAnalysis(param: LogAnalysisParams) {
	if ( param.simulatedAndVisualizedTransaction.tokenResults.length === 0 ) return <p class = 'paragraph'> No token events </p>
	const routes = identifyRoutes(param.simulatedAndVisualizedTransaction, param.identifiedSwap)
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'> { routes ?
		routes.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	:
		param.simulatedAndVisualizedTransaction.tokenResults.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	} </span>
}
