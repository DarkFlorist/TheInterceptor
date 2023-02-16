import { ERC721TokenApprovalChange, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenApprovalChange, TokenVisualizerERC20Event, TokenVisualizerERC721AllApprovalEvent, TokenVisualizerERC721Event, TokenVisualizerResultWithMetadata, TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { FromAddressToAddress, SmallAddress } from '../subcomponents/address.js'
import { EtherSymbol, TokenSymbol, TokenAmount, EtherAmount, Token721AmountField, ERC721TokenNumber } from '../subcomponents/coins.js'
import { CHAIN, LogAnalysisParams, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { QUARANTINE_CODES_DICT } from '../../simulation/protectors/quarantine-codes.js'
import { Error } from '../subcomponents/Error.js'
import { identifyRoutes, identifySwap, SwapVisualization } from './SwapTransactions.js'
import { Erc20ApprovalChanges, ERC721OperatorChange, ERC721OperatorChanges, ERC721TokenIdApprovalChanges } from './SimulationSummary.js'
import { identifyTransaction, nameTransaction } from './identifyTransaction.js'
import { makeYouRichTransaction } from './transactionExplainers.js'
import { JSXInternal } from 'preact/src/jsx'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'

function isPositiveEvent(visResult: TokenVisualizerResultWithMetadata, ourAddressInReferenceFrame: bigint) {
	if (!visResult.is721) {
		if (!visResult.isApproval) {
			return visResult.amount >= 0 // simple transfer
		}
		return visResult.amount === 0n // zero is only positive approve event
	}

	// nfts
	if ('isAllApproval' in visResult) { // all approval is only positive if someone all approves us, or all approval is removed from us
		return (visResult.allApprovalAdded && visResult.to.address === ourAddressInReferenceFrame) || (!visResult.allApprovalAdded && visResult.from.address === ourAddressInReferenceFrame)
	}

	if (visResult.isApproval) {
		return visResult.to.address === ourAddressInReferenceFrame // approval is only positive if we are getting approved
	}

	return visResult.to.address === ourAddressInReferenceFrame // send is positive if we are receiving
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
									<img src = { tx.statusCode === 'success' ? ( tx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
									</span>
								</div>

								<p class = 'card-header-title'>
									<p className = 'paragraph'>
										{ nameTransaction(tx, param.activeAddress) }
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
	const msgSender = tx.from
	// ether changes
	if (tx.ethBalanceChanges.filter( (x) => x.address === msgSender && x.after !== x.before ).length > 0) return true

	// token changes
	return tx.tokenResults.filter( (x) => x.from === msgSender || x.to === msgSender ).length > 0
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
				<div class = { `box token-box negative-box vertical-center` } style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = {`color: ${ param.textColor }; margin-bottom: 0px`}> Send&nbsp; </p>
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
							<p class = 'ellipsis' style = {`color: ${ param.textColor }; margin-bottom: 0px`}> Receive&nbsp; </p>
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
	tokenVisualizerResults: TokenVisualizerResultWithMetadata[] | undefined,
	textColor: string,
	renameAddressCallBack: RenameAddressCallBack,
}

function SendOrReceiveTokensImportanceBox(param: SendOrReceiveTokensImportanceBoxParams ) {
	if (param.tokenVisualizerResults === undefined) return <></>
	return <>
		{ param.tokenVisualizerResults.map( (tokenEvent) => (
			tokenEvent.isApproval ? <></> : <div class = 'vertical-center'>
				<div class = { `box token-box ${ param.sending ? 'negative-box' : 'positive-box' } vertical-center` } style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
								{ param.sending ? 'Send' : 'Receive' }&nbsp;
							</p>
						</div>
						<div class = 'log-cell'>
							{ tokenEvent.is721 ?
								<ERC721TokenNumber
									tokenId = { tokenEvent.tokenId }
									received = { !param.sending }
									textColor = { param.textColor }
									showSign = { false }
								/>
							:
								<TokenAmount
									amount = { tokenEvent.amount }
									tokenDecimals = { tokenEvent.token.decimals }
									textColor = { param.textColor }
								/>
							}
						</div>
						<div class = 'log-cell' style = 'padding-right: 0.2em'>
							<TokenSymbol
								tokenName = { tokenEvent.token.name }
								tokenAddress = { tokenEvent.token.address }
								tokenSymbol = { tokenEvent.token.symbol }
								tokenLogoUri = { tokenEvent.token.logoUri }
								textColor = { param.textColor }
								useFullTokenName = { false }
							/>
						</div>
					</table>
				</div>
			</div>
		) ) }
	</>
}

type TransactionImportanceBlockParams = {
	tx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: RenameAddressCallBack,
}

// showcases the most important things the transaction does
export function TransactionImportanceBlock( param: TransactionImportanceBlockParams ) {
	if ( param.tx.statusCode === 'failure') return <></>
	const identifiedSwap = identifySwap(param.tx)
	const textColor =  'var(--text-color)'

	if(identifiedSwap) {
		return <SwapVisualization
			identifiedSwap = { identifiedSwap }
			chain = { param.simulationAndVisualisationResults.chain }
		/>
	}

	const msgSender = param.tx.from.address

	const sendingTokenResults = param.tx.tokenResults.filter( (x) => x.from.address === msgSender)
	const receivingTokenResults = param.tx.tokenResults.filter( (x) => x.to.address === msgSender)

	const erc20tokenApprovalChanges: TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC20Event  => x.isApproval && !x.is721).map((entry) => {
		return {
			tokenName: entry.token.name,
			tokenAddress: entry.token.address,
			tokenSymbol: entry.token.symbol,
			tokenDecimals: entry.token.decimals,
			tokenLogoUri: entry.token.logoUri,
			approvals: [ {...entry.to, change: entry.amount } ]
		}
	})

	const operatorChanges: ERC721OperatorChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC721AllApprovalEvent  => 'isAllApproval' in x && x.is721).map((entry) => {
		return {
			tokenName: entry.token.name,
			tokenAddress: entry.token.address,
			tokenSymbol: entry.token.symbol,
			tokenLogoUri: entry.token.logoUri,
			operator: 'allApprovalAdded' in entry && entry.allApprovalAdded ? entry.to : undefined
		}
	})

	// token address, tokenId, approved address
	const tokenIdApprovalChanges: ERC721TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC721Event  => 'tokenId' in x && x.isApproval).map((entry) => {
		return {
			token: {
				tokenId: entry.tokenId,
				tokenName: entry.token.name,
				tokenAddress: entry.token.address,
				tokenSymbol: entry.token.symbol,
				tokenLogoUri: entry.token.logoUri,
			},
			approvedEntry: entry.to
		}
	})

	const ownBalanceChanges = param.tx.ethBalanceChanges.filter( (change) => change.address.address === msgSender)

	return <div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px;'>
		{ /* sending ether / tokens */ }
		<EtherTransferEvent
			valueSent = { param.tx.value }
			totalReceived = { ownBalanceChanges !== undefined && ownBalanceChanges.length > 0 ? ownBalanceChanges[ownBalanceChanges.length - 1].after - ownBalanceChanges[0].before : 0n  }
			textColor = { textColor }
			chain = { param.simulationAndVisualisationResults.chain }
		/>

		<SendOrReceiveTokensImportanceBox
			tokenVisualizerResults = { sendingTokenResults.filter( (x) => !x.isApproval) }
			sending = { true }
			textColor = { textColor }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>

		{ /* us approving other addresses */ }
		<Erc20ApprovalChanges
			tokenApprovalChanges = { erc20tokenApprovalChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<ERC721OperatorChanges
			ERC721OperatorChanges = { operatorChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<ERC721TokenIdApprovalChanges
			ERC721TokenIdApprovalChanges = { tokenIdApprovalChanges }
			textColor = { textColor }
			negativeColor = { textColor }
			isImportant = { true }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>

		{ /* receiving tokens */ }
		<SendOrReceiveTokensImportanceBox
			tokenVisualizerResults = { receivingTokenResults.filter( (x) => !x.isApproval) }
			sending = { false }
			textColor = { textColor }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
	</div>
}

function normalTransaction(param: TransactionVisualizationParameters) {
	const identifiedSwap = identifySwap(param.tx)
	return (
		<div class = 'block' style = 'background-color: var(--card-bg-color);'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.tx.statusCode === 'success' ? ( param.tx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
						{ nameTransaction(param.tx, param.activeAddress) }
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'remove' onClick = { () => param.removeTransaction(param.tx.hash) }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<div class = 'card-content'>
				{ param.tx.to === undefined ? <>Contract deployment</> :
					<div class = 'container'>
						<div class = 'notification' style = { `${ areThereImportantEventsToHighlight(param.tx , param.simulationAndVisualisationResults) ? 'background-color: var(--unimportant-text-color); margin-bottom: 10px;' : 'background-color: unset;' } padding: 10px` } >
							<FromAddressToAddress
								fromEntry = { param.tx.from }
								toEntry = { param.tx.to }
								isApproval = { false }
								renameAddressCallBack = { param.renameAddressCallBack }
							/>
							<div class = 'content importance-box-content' >
								<TransactionImportanceBlock
									tx = { param.tx }
									simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
								{ param.tx.quarantineCodes.map( (code) => (
									<div style = 'padding-top: 10px'>
										<Error text = { QUARANTINE_CODES_DICT[code].label } />
									</div>
								)) }
							</div>
						</div>
					</div>
				}
				<div class = 'container'>
					<div class = 'notification' style = 'background-color: unset; padding-right: 10px; padding-left: 10px; padding-top: 0px; padding-bottom: 0px;'>
						<LogAnalysis
							simulatedAndVisualizedTransaction = { param.tx }
							identifiedSwap = { identifiedSwap }
							renameAddressCallBack = { param.renameAddressCallBack }
						/>
					</div>
				</div>
				{ param.tx.statusCode !== 'success' ? <Error text = { `The transaction fails with error '${ param.tx.error }'` } /> : <></>}
				{ param.tx.realizedGasPrice > 0n ?
					<table class = 'log-table' style = 'width: fit-content; margin: 0 0 0 auto;'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = {`color: var(--subtitle-text-color); margin-bottom: 0px`}> Gas fee:&nbsp;</p>
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<EtherAmount
								amount = { param.tx.gasSpent * param.tx.realizedGasPrice  }
								textColor = { 'var(--subtitle-text-color)' }
							/>
						</div>
						<div class = 'log-cell'>
							<EtherSymbol
								amount = { param.tx.gasSpent * param.tx.realizedGasPrice  }
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
	renameAddressCallBack: RenameAddressCallBack,
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
						renameAddressCallBack = { param.renameAddressCallBack }
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
				{ params.tokenVisualizerResult.is721 ?
					<Token721AmountField
						{ ...params.tokenVisualizerResult }
						textColor = { textColor }
					/>
				: <> { params.tokenVisualizerResult.amount >= (2n ** 96n - 1n ) && params.tokenVisualizerResult.isApproval ?
						<p class = 'ellipsis' style = { `color: ${ textColor }` }><b>ALL</b></p>
					:
						<TokenAmount
							amount = { params.tokenVisualizerResult.amount }
							tokenDecimals = { params.tokenVisualizerResult.token.decimals }
							textColor = { textColor }
						/>
					} </>
				}
			</div>
			<div class = 'log-cell' style = 'padding-right: 0.2em'>
				<TokenSymbol
					tokenName = { params.tokenVisualizerResult.token.name }
					tokenAddress = { params.tokenVisualizerResult.token.address }
					tokenLogoUri = { params.tokenVisualizerResult.token.logoUri }
					tokenSymbol = { params.tokenVisualizerResult.token.symbol }
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
	if ( param.simulatedAndVisualizedTransaction.tokenResults.length === 0 ) return <></>
	const routes = identifyRoutes(param.simulatedAndVisualizedTransaction, param.identifiedSwap)
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'> { routes ?
		routes.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	:
		param.simulatedAndVisualizedTransaction.tokenResults.map( (tokenVisualizerResult) => (
			<TokenLogEvent
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	} </span>
}
