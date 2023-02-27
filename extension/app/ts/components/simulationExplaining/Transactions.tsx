import { ERC721TokenApprovalChange, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenApprovalChange, TokenVisualizerERC20Event, TokenVisualizerERC721AllApprovalEvent, TokenVisualizerERC721Event, TokenVisualizerResultWithMetadata, TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { EtherSymbol, TokenSymbol, TokenAmount, EtherAmount, Token721AmountField, ERC721TokenNumber } from '../subcomponents/coins.js'
import { CHAIN, LogAnalysisParams, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { QUARANTINE_CODES_DICT } from '../../simulation/protectors/quarantine-codes.js'
import { Error } from '../subcomponents/Error.js'
import { identifyRoutes, identifySwap, SwapVisualization } from './SwapTransactions.js'
import { Erc20ApprovalChanges, ERC721OperatorChange, ERC721OperatorChanges, ERC721TokenIdApprovalChanges, GasFee, LogAnalysisCard, TransactionHeader } from './SimulationSummary.js'
import { identifyTransaction } from './identifyTransaction.js'
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

export function QuarantineCodes({ tx }: { tx: SimulatedAndVisualizedTransaction }) {
	return <> {
		tx.quarantineCodes.map( (code) => (
			<div style = 'margin-top: 10px;margin-bottom: 10px'>
				<Error text = { QUARANTINE_CODES_DICT[code].label } />
			</div>
		))
	} </>
}

type TransactionImportanceBlockParams = {
	tx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: RenameAddressCallBack,
}

// showcases the most important things the transaction does
export function TransactionImportanceBlock( param: TransactionImportanceBlockParams ) {
	if ( param.tx.statusCode === 'failure') return <>
		<div>
			<Error text = { `The transaction fails with an error '${ param.tx.error }'` } />
		</div>
		<QuarantineCodes tx = { param.tx }/>
	</>
	const identifiedSwap = identifySwap(param.tx)
	const textColor = 'var(--text-color)'

	if (identifiedSwap) {
		return <>
			<SwapVisualization
				identifiedSwap = { identifiedSwap }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<QuarantineCodes tx = { param.tx }/>
		</>
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

	if (param.tx.tokenResults.length === 0 && param.tx.ethBalanceChanges.length === 0 ) {
		return <>
			<div class = 'notification transaction-importance-box'>
				<p class = 'paragraph'> The transaction does no visible changes</p>
			</div>
			<QuarantineCodes tx = { param.tx }/>
		</>
	}

	return <>
		<div class = 'notification transaction-importance-box'>
			<div style = 'display: grid; grid-template-rows: max-content max-content' >
				{ /* sending ether / tokens */ }
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<EtherTransferEvent
						valueSent = { param.tx.value }
						totalReceived = { ownBalanceChanges !== undefined && ownBalanceChanges.length > 0 ? ownBalanceChanges[ownBalanceChanges.length - 1].after - ownBalanceChanges[0].before : 0n  }
						textColor = { textColor }
						chain = { param.simulationAndVisualisationResults.chain }
					/>
				</div>

				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<SendOrReceiveTokensImportanceBox
						tokenVisualizerResults = { sendingTokenResults.filter( (x) => !x.isApproval) }
						sending = { true }
						textColor = { textColor }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>

				{ /* us approving other addresses */ }
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<Erc20ApprovalChanges
						tokenApprovalChanges = { erc20tokenApprovalChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<ERC721OperatorChanges
						ERC721OperatorChanges = { operatorChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<ERC721TokenIdApprovalChanges
						ERC721TokenIdApprovalChanges = { tokenIdApprovalChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>

				{ /* receiving tokens */ }
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<SendOrReceiveTokensImportanceBox
						tokenVisualizerResults = { receivingTokenResults.filter( (x) => !x.isApproval) }
						sending = { false }
						textColor = { textColor }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
			</div>
		</div>
		<QuarantineCodes tx = { param.tx }/>
	</>
}

function normalTransaction(param: TransactionVisualizationParameters) {
	return (
		<div class = 'card'>
			<TransactionHeader
				tx = { param.tx }
				renameAddressCallBack =  { param.renameAddressCallBack }
				activeAddress = { param.activeAddress }
				removeTransaction = { () => param.removeTransaction(param.tx.hash) }
			/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						tx = { param.tx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
				<LogAnalysisCard
					tx = { param.tx }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; column-gap: 5px; justify-content: space-between; grid-template-columns: auto auto'>
					<div class = 'log-cell' style = ''>
						<p style = { `color: var(--subtitle-text-color);` }> Transaction sender: </p>
					</div>
					<div class = 'log-cell' style = ''>
						<SmallAddress
							addressBookEntry = { param.tx.from }
							textColor = { 'var(--subtitle-text-color)' }
							renameAddressCallBack = { param.renameAddressCallBack }
						/>
					</div>
				</span>

				<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content auto;'>
					<GasFee tx = { param.tx } chain = { param.simulationAndVisualisationResults.chain } />
					<div class = 'log-cell' style = 'justify-content: right;'>
						<WebsiteOriginText { ...param.tx.website } textColor = { 'var(--subtitle-text-color)' }  />
					</div>
				</span>
			</div>
		</div>
	)
}

export const transactionExplainers = new Map<string, (param: TransactionVisualizationParameters) => JSXInternal.Element >([
	['MakeYouRichTransaction', makeYouRichTransaction],
])

function Transaction(param: TransactionVisualizationParameters) {
	const identifiedTransaction = identifyTransaction(param.tx, param.activeAddress).type
	const handler = transactionExplainers.get(identifiedTransaction)
	if (handler === undefined) {
		return normalTransaction(param)
	}
	return handler(param)
}

type TransactionsParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (hash: bigint) => void,
	activeAddress: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Transactions(param: TransactionsParams) {
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
	if ( param.simulatedAndVisualizedTransaction.tokenResults.length === 0 ) return <p class = 'paragraph'> No token events </p>
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
