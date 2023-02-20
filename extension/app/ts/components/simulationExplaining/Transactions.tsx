import { ERC721TokenApprovalChange, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenApprovalChange, TokenVisualizerERC20Event, TokenVisualizerERC721AllApprovalEvent, TokenVisualizerERC721Event, TokenVisualizerResultWithMetadata, TransactionVisualizationParameters } from '../../utils/visualizer-types.js'
import { SmallAddress, Website } from '../subcomponents/address.js'
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
			<div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px;'>
				<p class = 'paragraph'> The transaction does no visible changes</p>
			</div>
			<QuarantineCodes tx = { param.tx }/>
		</>
	}

	return <>
		<div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px;'>
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
						<Website { ...param.website } textColor = { 'var(--subtitle-text-color)' }  />
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
					website = { { // TODO, attach website to transactions and display right one here
						websiteIcon: 'data:image/png;base64,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',
						websiteOrigin: 'just.a.mockup.website'
					} }
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
