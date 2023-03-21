import { TransactionImportanceBlockParams } from '../Transactions.js'
import { Erc20ApprovalChanges, ERC721OperatorChange, ERC721OperatorChanges, ERC721TokenIdApprovalChanges } from '../SimulationSummary.js'
import { ERC721TokenApprovalChange, TokenApprovalChange, TokenVisualizerERC20Event, TokenVisualizerERC721AllApprovalEvent, TokenVisualizerERC721Event, TokenVisualizerResultWithMetadata } from '../../../utils/visualizer-types.js'
import { EtherSymbol, TokenSymbol, TokenAmount, EtherAmount, ERC721TokenNumber } from '../../subcomponents/coins.js'
import { CHAIN, RenameAddressCallBack } from '../../../utils/user-interface-types.js'

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
									id = { tokenEvent.tokenId }
									received = { !param.sending }
									textColor = { param.textColor }
									showSign = { false }
								/>
							:
								<TokenAmount
									amount = { tokenEvent.amount }
									decimals = { tokenEvent.token.decimals }
									textColor = { param.textColor }
								/>
							}
						</div>
						<div class = 'log-cell' style = 'padding-right: 0.2em'>
							<TokenSymbol
								{ ...tokenEvent.token }
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

export function CatchAllVisualizer(param: TransactionImportanceBlockParams) {
	const msgSender = param.tx.from.address

	const sendingTokenResults = param.tx.tokenResults.filter((x) => x.from.address === msgSender)
	const receivingTokenResults = param.tx.tokenResults.filter((x) => x.to.address === msgSender)

	const erc20tokenApprovalChanges: TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC20Event  => x.isApproval && !x.is721).map((entry) => {
		return {
			...entry.token,
			approvals: [ {...entry.to, change: entry.amount } ]
		}
	})

	const operatorChanges: ERC721OperatorChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC721AllApprovalEvent  => 'isAllApproval' in x && x.is721).map((entry) => {
		return {
			...entry.token,
			operator: 'allApprovalAdded' in entry && entry.allApprovalAdded ? entry.to : undefined
		}
	})

	// token address, tokenId, approved address
	const tokenIdApprovalChanges: ERC721TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerERC721Event  => 'tokenId' in x && x.isApproval).map((entry) => {
		return {
			token: {
				...entry.token,
				id: entry.tokenId,
			},
			approvedEntry: entry.to
		}
	})

	const ownBalanceChanges = param.tx.ethBalanceChanges.filter( (change) => change.address.address === msgSender)

	if (param.tx.tokenResults.length === 0 && param.tx.ethBalanceChanges.length === 0 ) {
		return <div class = 'notification transaction-importance-box'>
			<p class = 'paragraph'> The transaction does no visible changes</p>
		</div>
	}

	const textColor = 'var(--text-color)'

	return <div class = 'notification transaction-importance-box'>
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
}
