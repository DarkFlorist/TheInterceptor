import { addressString } from '../../utils/bigint.js'
import { AddressMetadata, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenVisualizerResult, TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { FromAddressToAddress, SmallAddress } from '../subcomponents/address.js'
import { EtherSymbol, Token, ERC721Token, TokenSymbol, TokenAmount, EtherAmount, Token721AmountField } from '../subcomponents/coins.js'
import { CHAIN, LogAnalysisParams } from '../../utils/user-interface-types.js'
import { QUARANTINE_CODES_DICT } from '../../simulation/protectors/quarantine-codes.js'
import { Error } from '../subcomponents/Error.js'
import { identifyRoutes, identifySwap, SwapVisualization } from './SwapTransactions.js'
import { Erc20ApprovalChanges, ERC721OperatorChanges, ERC721TokenIdApprovalChanges } from './SimulationSummary.js'
import { identifyTransaction, nameTransaction } from './identifyTransaction.js'
import { makeYouRichTransaction } from './transactionExplainers.js'
import { JSXInternal } from 'preact/src/jsx'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'

function isPositiveEvent(visResult: TokenVisualizerResult, ourAddressInReferenceFrame: bigint) {
	if (!visResult.is721) {
		if (!visResult.isApproval) {
			return visResult.amount >= 0 // simple transfer
		}
		return visResult.amount === 0n // zero is only positive approve event
	}

	// nfts
	if ('isAllApproval' in visResult) { // all approval is only positive if someone all approves us, or all approval is removed from us
		return (visResult.allApprovalAdded && visResult.to === ourAddressInReferenceFrame) || (!visResult.allApprovalAdded && visResult.from === ourAddressInReferenceFrame)
	}

	if (visResult.isApproval) {
		return visResult.to === ourAddressInReferenceFrame // approval is only positive if we are getting approved
	}

	return visResult.to === ourAddressInReferenceFrame // send is positive if we are receiving
}

type TransactionAggregateParam = {
	txs: SimulatedAndVisualizedTransaction[],
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	activeAddress: bigint,
}

function TransactionAggregate(param: TransactionAggregateParam) {
	return ( <> {
		param.txs.map((tx, _index) => (
			<li>
				<div style = 'position: relative; z-index: 0;'>
					<div style = 'background-color: var(--disabled-card-color);' >
						<div class = 'block' style = 'background-color: var(--disabled-card-color); position: relative; z-index: -1;'>
							<header class = 'card-header'>
								<div class = 'card-header-icon unset-cursor'>
									<span class = 'icon'>
									<img src = { tx.multicallResponse.statusCode === 'success' ? ( tx.simResults && tx.simResults.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
									</span>
								</div>

								<p class = 'card-header-title'>
									<p className = 'paragraph'>
										{ nameTransaction(tx, param.simulationAndVisualisationResults.addressMetadata, param.activeAddress) }
									</p>
								</p>
							</header>
						</div>
					</div>
				</div>
			</li>
		))
	} </> )
}

function areThereImportantEventsToHighlight(tx: SimulatedAndVisualizedTransaction, _simulationAndVisualisationResults: SimulationAndVisualisationResults ) {
	const identifiedSwap = identifySwap(tx)
	if (identifiedSwap) return true
	const msgSender = tx.unsignedTransaction.from
	if (tx.simResults?.visualizerResults === undefined) return false

	// ether changes
	if (tx.simResults?.visualizerResults?.ethBalanceChanges.filter( (x) => x.address === msgSender && x.after !== x.before ).length > 0) return true

	// token changes
	return tx.simResults.visualizerResults.tokenResults.filter( (x) => x.from === msgSender || x.to === msgSender ).length > 0
}

type EtherTransferEventParams = {
	valueSent: bigint,
	totalReceived: bigint,
	textColor: string,
	chain: CHAIN,
}

function EtherTransferEvent(param: EtherTransferEventParams) {
	return <>
		{ param.valueSent === 0n ? <></> :
			<div class = 'vertical-center'>
				<div class = 'box token-box negative-box vertical-center' style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = {`color: ${ param.textColor }; margin-bottom: 0px`}> Send </p>
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<EtherAmount
								amount = { param.valueSent }
								textColor = { param.textColor }
							/>
						</div>
						<div class = 'log-cell'>
							<EtherSymbol
								amount = { param.valueSent }
								textColor = { param.textColor }
								chain = { param.chain }
							/>
						</div>
					</table>
				</div>
			</div>
		}
		{ param.totalReceived <= 0n ? <></> :
			<div class = 'vertical-center'>
				<div class = 'box token-box positive-box vertical-center' style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = {`color: ${ param.textColor }; margin-bottom: 0px`}> Receive </p>
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<EtherAmount
								amount = { param.totalReceived }
								textColor = { param.textColor }
							/>
						</div>
						<div class = 'log-cell'>
							<EtherSymbol
								amount = { param.totalReceived }
								textColor = { param.textColor }
								chain = { param.chain }
							/>
						</div>
					</table>
				</div>
			</div>
		}
	</>
}

type SendOrReceiveTokensImportanceBoxParams = {
	sending: boolean,
	tokenVisualizerResults: TokenVisualizerResult[] | undefined,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
}

function SendOrReceiveTokensImportanceBox(param: SendOrReceiveTokensImportanceBoxParams ) {
	if (param.tokenVisualizerResults === undefined) return <></>
	return <>
		{ param.tokenVisualizerResults.map( (tokenEvent) => (
			tokenEvent.isApproval ? <></> : <div class = 'vertical-center'>
				{ param.sending ?
					<div class = 'box token-box negative-box vertical-center' style = 'display: inline-block'>
						<p style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
							Send
							{ tokenEvent.is721 ?
								<ERC721Token
									tokenId = { tokenEvent.tokenId }
									token = { tokenEvent.tokenAddress }
									addressMetadata = { param.addressMetadata.get(addressString(tokenEvent.tokenAddress)) }
									textColor = { param.textColor }
									useFullTokenName = { false }
									received = { false }
									showSign = { false }
								/> :
								<Token
									amount = { tokenEvent.amount }
									token = { tokenEvent.tokenAddress }
									showSign = { false }
									addressMetadata = { param.addressMetadata.get(addressString(tokenEvent.tokenAddress)) }
									textColor = { param.textColor }
									useFullTokenName = { false }
								/>
							}
							to&nbsp;
							<SmallAddress
								address = { tokenEvent.to }
								addressMetaData = { param.addressMetadata.get(addressString(tokenEvent.to)) }
								textColor = { param.textColor }
							/>
						</p>
					</div>
					:
					<div class = 'box token-box positive-box vertical-center' style = 'display: inline-block'>
						<p style = {`color: ${ param.textColor }; margin-bottom: 0px; display: inline-block`}>
							Receive
							{ tokenEvent.is721 ?
								<ERC721Token
									tokenId = { tokenEvent.tokenId }
									token = { tokenEvent.tokenAddress }
									addressMetadata = { param.addressMetadata.get(addressString(tokenEvent.tokenAddress)) }
									textColor = { param.textColor }
									useFullTokenName = { false }
									received = { true }
									showSign = { false }
								/> :
								<Token
									amount = { tokenEvent.amount }
									token = { tokenEvent.tokenAddress }
									showSign = { false }
									addressMetadata = { param.addressMetadata.get(addressString(tokenEvent.tokenAddress)) }
									textColor = { param.textColor }
									useFullTokenName = { false }
								/>
							}
							from&nbsp;
							<SmallAddress
								address = { tokenEvent.tokenAddress }
								addressMetaData = { param.addressMetadata.get(addressString(tokenEvent.tokenAddress)) }
								textColor = { param.textColor }
							/>
						</p>
					</div>
				}
				</div>
			))
		}
	</>
}

type TransactionImportanceBlockParams = {
	tx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
}

// showcases the most important things the transaction does
function TransactionImportanceBlock( param: TransactionImportanceBlockParams ) {
	if ( param.tx.multicallResponse.statusCode === 'failure') return <></>
	const identifiedSwap = identifySwap(param.tx)
	const textColor =  'var(--text-color)'

	if(identifiedSwap) {
		return <SwapVisualization
			identifiedSwap = { identifiedSwap }
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			chain = { param.simulationAndVisualisationResults.chain }
		/>
	}

	const msgSender = param.tx.unsignedTransaction.from

	const sendingTokenResults = param.tx.simResults?.visualizerResults?.tokenResults.filter( (x) => x.from === msgSender)
	const receivingTokenResults = param.tx.simResults?.visualizerResults?.tokenResults.filter( (x) => x.to === msgSender)

	// tokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount
	const tokenApprovalChanges: Map<string, Map<string, bigint > > = sendingTokenResults ? new Map( sendingTokenResults.filter( (x) => x.isApproval && !x.is721).map(
		(x) => [ addressString(x.tokenAddress), new Map( [ [ addressString(x.to), 'amount' in x ? x.amount : 0n ] ]  ) ]
	)) : new Map()

	// ERC721OperatorChanges: Map<string, string | undefined>
	const operatorChanges: Map<string, string | undefined> = sendingTokenResults ? new Map( sendingTokenResults.filter( (x) => x.isApproval && x.is721 && ('isAllApproval' in x && x.isAllApproval) ).map(
		(x) => [ addressString(x.tokenAddress), 'allApprovalAdded' in x && x.allApprovalAdded ? addressString(x.to) : undefined ]
	)) : new Map()

	// token address, tokenId, approved address
	const tokenIdApprovalChanges: Map<string, Map<string, string > > = sendingTokenResults ? new Map( sendingTokenResults.filter( (x) => x.isApproval && x.is721).map(
		(x) => [ addressString(x.tokenAddress), new Map( [ [ 'tokenId' in x ? x.tokenId : 0n, x.to ] ]  ) ]
	)) : new Map()

	const ownBalanceChanges = param.tx.simResults?.visualizerResults?.ethBalanceChanges.filter( (change) => change.address === msgSender)

	return <>
		{ /* sending ether / tokens */ }
		<EtherTransferEvent
			valueSent = { param.tx.signedTransaction.value }
			totalReceived = { ownBalanceChanges !== undefined && ownBalanceChanges.length > 0 ? ownBalanceChanges[ownBalanceChanges.length - 1].after - ownBalanceChanges[0].before : 0n  }
			textColor = { textColor }
			chain = { param.simulationAndVisualisationResults.chain }
		/>

		<SendOrReceiveTokensImportanceBox
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			tokenVisualizerResults = { sendingTokenResults?.filter( (x) => !x.isApproval) }
			sending = { true }
			textColor = { textColor }
		/>

		{ /* us approving other addresses */ }
		<Erc20ApprovalChanges
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			tokenApprovalChanges = { tokenApprovalChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
		/>
		<ERC721OperatorChanges
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			ERC721OperatorChanges = { operatorChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
		/>
		<ERC721TokenIdApprovalChanges
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			ERC721TokenIdApprovalChanges = { tokenIdApprovalChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
		/>

		{ /* receiving tokens */ }
		<SendOrReceiveTokensImportanceBox
			addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
			tokenVisualizerResults = { receivingTokenResults?.filter( (x) => !x.isApproval) }
			sending = { false }
			textColor = { textColor }
		/>
	</>
}

function normalTransaction(param: TransactionVisualizationParameters) {
	const identifiedSwap = identifySwap(param.tx)
	return (
		<div class = 'block' style = 'background-color: var(--card-bg-color);'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.tx.multicallResponse.statusCode === 'success' ? ( param.tx.simResults && param.tx.simResults.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
						{ nameTransaction(param.tx, param.simulationAndVisualisationResults.addressMetadata, param.activeAddress) }
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'remove' onClick = { () => param.removeTransaction(param.tx.signedTransaction.hash) }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<div class = 'card-content'>
				{ param.tx.signedTransaction.to === null ? <>Contract deployment</> :
					<div class = 'container'>
						<div class = 'notification' style = { `${ areThereImportantEventsToHighlight(param.tx , param.simulationAndVisualisationResults) ? 'background-color: var(--unimportant-text-color); margin-bottom: 10px;' : 'background-color: unset;' } padding: 10px` } >
							<FromAddressToAddress
								from = { param.tx.signedTransaction.from }
								to = { param.tx.signedTransaction.to }
								fromAddressMetadata = { param.simulationAndVisualisationResults.addressMetadata.get(addressString(param.tx.signedTransaction.from)) }
								toAddressMetadata = { param.simulationAndVisualisationResults.addressMetadata.get(addressString(param.tx.signedTransaction.to)) }
								isApproval = { false }
							/>
							<div class = 'content importance-box-content' >
								<TransactionImportanceBlock
									tx = { param.tx }
									simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
								/>
								{ param.tx.simResults !== undefined ? <>
									{ param.tx.simResults.quarantineCodes.map( (code) => (
										<div style = 'padding-top: 10px'>
											<Error text = { QUARANTINE_CODES_DICT[code].label } />
										</div>
									)) }
									</> : <></>
								}
							</div>
						</div>
					</div>
				}
				{ param.tx.simResults !== undefined ?  <>
					<div class = 'container'>
						<div class = 'notification' style = 'background-color: unset; padding-right: 10px; padding-left: 10px; padding-top: 0px; padding-bottom: 0px;'>
							<LogAnalysis simulatedAndVisualizedTransaction = { param.tx } addressMetadata = { param.simulationAndVisualisationResults.addressMetadata } identifiedSwap = { identifiedSwap } />
						</div>
					</div>
				</> : <></> }
				{ param.tx.multicallResponse.statusCode !== 'success' ? <Error text = { `The transaction fails with error '${param.tx.multicallResponse.error}'` } /> : <></>}
				{ param.tx.realizedGasPrice > 0n ?
					<table class = 'log-table' style = 'width: fit-content; margin: 0 0 0 auto;'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = {`color: var(--subtitle-text-color); margin-bottom: 0px`}> Gas fee:&nbsp;</p>
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<EtherAmount
								amount = { param.tx.multicallResponse.gasSpent * param.tx.realizedGasPrice  }
								textColor = { 'var(--subtitle-text-color)' }
							/>
						</div>
						<div class = 'log-cell'>
							<EtherSymbol
								amount = { param.tx.multicallResponse.gasSpent * param.tx.realizedGasPrice  }
								textColor = { 'var(--subtitle-text-color)' }
								chain = { param.simulationAndVisualisationResults.chain }
							/>
						</div>
					</table>
					: <></>
				}
			</div>
		</div>
	)
}

export const transactionExplainers = new Map<string, (param: TransactionVisualizationParameters) => JSXInternal.Element >([
	['MakeYouRichTransaction', makeYouRichTransaction],
])

function Transaction(param: TransactionVisualizationParameters) {
	const identifiedTransaction = identifyTransaction(param.tx, param.activeAddress)
	const handler = transactionExplainers.get(identifiedTransaction)
	if (handler === undefined) {
		return normalTransaction(param)
	}
	return handler(param)
}

type TransactionsParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (hash: bigint) => void,
	showOnlyOneAndAggregateRest?: boolean,
	activeAddress: bigint,
}

export function Transactions(param: TransactionsParams) {
	if(param.showOnlyOneAndAggregateRest) {
		if (param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length === 0) return <></>
		return (
			<ul>
				{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length > 1 ?
					<TransactionAggregate
						txs = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.slice(0, -1) }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						activeAddress = { param.activeAddress }
					/>
				: <></>}
				<li>
					<Transaction
						tx = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)! }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						removeTransaction = { param.removeTransaction }
						activeAddress = { param.activeAddress }
					/>
				</li>
			</ul>
		)
	}
	return <ul>
		{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map((tx, _index) => (
			<li>
				<Transaction
					tx = { tx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					removeTransaction = { param.removeTransaction }
					activeAddress = { param.activeAddress }
				/>
			</li>
		)) }
	</ul>
}

type TokenLogEventParams = {
	tokenVisualizerResult: TokenVisualizerResult
	addressMetadata: Map<string, AddressMetadata>
	ourAddressInReferenceFrame: bigint,
}

export function TokenLogEvent(params: TokenLogEventParams ) {
	const textColor = isPositiveEvent(params.tokenVisualizerResult, params.ourAddressInReferenceFrame) ? 'var(--dim-text-color)' : 'var(--negative-dim-color)'

	return <>
			<div class = 'log-cell' style = 'justify-content: right;'>
				{ params.tokenVisualizerResult.is721 ?
					<Token721AmountField
						visResult = { params.tokenVisualizerResult }
						textColor = { textColor }
					/>
				: <> { params.tokenVisualizerResult.amount > 2n ** 100n && params.tokenVisualizerResult.isApproval ?
						<p class = 'ellipsis' style = { `color: ${ textColor }` }><b>ALL</b></p>
					:
						<TokenAmount
							amount = { params.tokenVisualizerResult.amount }
							addressMetadata = { params.addressMetadata.get(addressString(params.tokenVisualizerResult.tokenAddress)) }
							textColor = { textColor }
						/>
					} </>
				}
			</div>
			<div class = 'log-cell'>
				<TokenSymbol
					token = { params.tokenVisualizerResult.tokenAddress }
					addressMetadata = { params.addressMetadata.get(addressString(params.tokenVisualizerResult.tokenAddress)) }
					textColor = { textColor }
					useFullTokenName = { false }
				/>&nbsp;
			</div>
			<div class = 'log-cell'>
				<SmallAddress
					address = { params.tokenVisualizerResult.from }
					addressMetaData = { params.addressMetadata.get(addressString(params.tokenVisualizerResult.from)) }
					textColor = { textColor }
				/>
			</div>
			<div class = 'log-cell'>
				{ params.tokenVisualizerResult.isApproval ? <ApproveIcon color = { textColor } /> : <ArrowIcon color = { textColor } /> }
			</div>
			<div class = 'log-cell'>
				<SmallAddress
					address = { params.tokenVisualizerResult.to }
					addressMetaData = { params.addressMetadata.get(addressString(params.tokenVisualizerResult.to)) }
					textColor = { textColor }
				/>
			</div>
	</>
}

function LogAnalysis(param: LogAnalysisParams) {
	if ( param.simulatedAndVisualizedTransaction?.simResults?.visualizerResults === undefined ) return <></>
	if ( param.simulatedAndVisualizedTransaction.simResults.visualizerResults.tokenResults.length === 0 ) return <></>
	const routes = identifyRoutes(param.simulatedAndVisualizedTransaction, param.identifiedSwap)
	return <table class = 'log-table' style = 'justify-content: center; column-gap: 5px;'> { routes ?
		routes.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				addressMetadata = { param.addressMetadata }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.unsignedTransaction.from }
			/>
		))
	:
		param.simulatedAndVisualizedTransaction.simResults.visualizerResults.tokenResults.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				addressMetadata = { param.addressMetadata }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.unsignedTransaction.from }
			/>
		))
	} </table>
}
