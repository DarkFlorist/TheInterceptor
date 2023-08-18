import { TransactionImportanceBlockParams } from '../Transactions.js'
import { Erc1155OperatorChange, Erc20ApprovalChanges, Erc721OperatorChange, Erc721TokenIdApprovalChanges, Erc721or1155OperatorChanges } from '../SimulationSummary.js'
import { Erc721TokenApprovalChange, ERC20TokenApprovalChange, TokenVisualizerErc20Event, TokenVisualizerErc721Event, TokenVisualizerResultWithMetadata, RpcNetwork, TokenVisualizerNFTAllApprovalEvent } from '../../../utils/visualizer-types.js'
import { EtherSymbol, TokenSymbol, TokenAmount, EtherAmount } from '../../subcomponents/coins.js'
import { RenameAddressCallBack } from '../../../utils/user-interface-types.js'
import { SmallAddress } from '../../subcomponents/address.js'

type EtherTransferEventParams = {
	valueSent: bigint,
	totalReceived: bigint,
	textColor: string,
	rpcNetwork: RpcNetwork,
}

function EtherTransferEvent(param: EtherTransferEventParams) {
	return <>
		{ param.valueSent === 0n
			? null
			: <div class = 'vertical-center'>
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
								textColor = { param.textColor }
								rpcNetwork = { param.rpcNetwork }
							/>
						</div>
					</table>
				</div>
			</div>
		}
		{ param.totalReceived <= 0n
			? null
			: <div class = 'vertical-center'>
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
								textColor = { param.textColor }
								rpcNetwork = { param.rpcNetwork }
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

function SendOrReceiveTokensImportanceBox(param: SendOrReceiveTokensImportanceBoxParams) {
	if (param.tokenVisualizerResults === undefined) return null
	return <>
		{ param.tokenVisualizerResults.map((tokenEvent) => (
			tokenEvent.isApproval ? null : <div class = 'vertical-center'>
				<div class = { `box token-box ${ param.sending ? 'negative-box' : 'positive-box' } vertical-center` } style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
								{ param.sending ? 'Send' : 'Receive' }&nbsp;
							</p>
						</div>
						<div class = 'log-cell'>
							{ 'amount' in tokenEvent ?
								<TokenAmount
									amount = { tokenEvent.amount }
									decimals = { tokenEvent.token.decimals }
									textColor = { param.textColor }
								/>
							: null}
						</div>
						<div class = 'log-cell' style = 'padding-right: 0.2em'>
							<TokenSymbol
								{ ...tokenEvent.token }
								{ ...'tokenId' in tokenEvent ? { tokenId: tokenEvent.tokenId } : {} }
								textColor = { param.textColor }
								useFullTokenName = { false }
							/>
						</div>
						<div class = 'log-cell'>
							<p class = 'ellipsis' style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
								{ param.sending ? 'to' : 'from' }&nbsp;
							</p>
						</div>
						<div class = 'log-cell'>
							<SmallAddress 
								addressBookEntry = { param.sending ? tokenEvent.to : tokenEvent.from }
								renameAddressCallBack = { param.renameAddressCallBack }
							/>
						</div>
					</table>
				</div>
			</div>
		) ) }
	</>
}

export function CatchAllVisualizer(param: TransactionImportanceBlockParams) {
	const msgSender = param.simTx.transaction.from.address
	const sendingTokenResults = param.simTx.tokenResults.filter((x) => x.from.address === msgSender)
	const receivingTokenResults = param.simTx.tokenResults.filter((x) => x.to.address === msgSender)
	const erc20TokenApprovalChanges: ERC20TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerErc20Event  => x.isApproval && x.type === 'ERC20').map((entry) => {
		return {
			...entry.token,
			approvals: [ {...entry.to, change: entry.amount } ]
		}
	})

	const operatorChanges: (Erc721OperatorChange | Erc1155OperatorChange)[] = sendingTokenResults.filter((x): x is TokenVisualizerNFTAllApprovalEvent  => x.type === 'NFT All approval').map((entry) => {
		return {
			...entry.token,
			operator: 'allApprovalAdded' in entry && entry.allApprovalAdded ? entry.to : undefined
		}
	})

	// token address, tokenId, approved address
	const tokenIdApprovalChanges: Erc721TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerErc721Event  => 'tokenId' in x && x.isApproval).map((entry) => {
		return {
			token: {
				...entry.token,
				tokenId: entry.tokenId,
			},
			approvedEntry: entry.to
		}
	})

	const ownBalanceChanges = param.simTx.ethBalanceChanges.filter( (change) => change.address.address === msgSender)
	const totalEthReceived = ownBalanceChanges !== undefined && ownBalanceChanges.length > 0 ? ownBalanceChanges[ownBalanceChanges.length - 1].after - ownBalanceChanges[0].before - param.simTx.transaction.value : 0n

	if (param.simTx.transaction.to !== undefined
		&& param.simTx.transaction.value === 0n
		&& totalEthReceived <= 0n
		&& sendingTokenResults.length === 0
		&& receivingTokenResults.length === 0
	) {
		return <div class = 'notification transaction-importance-box'>
			<p class = 'paragraph'> The transaction does no visible important changes to your accounts</p>
		</div>
	}

	const textColor = 'var(--text-color)'

	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content' >
			{ /* contract creation */}
			{ param.simTx.transaction.to !== undefined ? null : <>
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<p class = 'paragraph'> The transaction deploys a contract </p>
				</div>
			</> }
			{ /* sending ether / tokens */ }
			<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
				<EtherTransferEvent
					valueSent = { param.simTx.transaction.value }
					totalReceived = { totalEthReceived }
					textColor = { textColor }
					rpcNetwork = { param.simulationAndVisualisationResults.rpcNetwork }
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
					erc20TokenApprovalChanges = { erc20TokenApprovalChanges }
					textColor = { textColor }
					negativeColor = { textColor }
					isImportant = { true }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
				<Erc721or1155OperatorChanges
					erc721or1155OperatorChanges = { operatorChanges }
					textColor = { textColor }
					negativeColor = { textColor }
					isImportant = { true }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
				<Erc721TokenIdApprovalChanges
					Erc721TokenIdApprovalChanges = { tokenIdApprovalChanges }
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
