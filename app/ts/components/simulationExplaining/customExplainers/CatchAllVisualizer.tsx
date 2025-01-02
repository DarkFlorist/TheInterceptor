import { TransactionImportanceBlockParams } from '../Transactions.js'
import { Erc1155OperatorChange, Erc20ApprovalChanges, Erc721OperatorChange, Erc721TokenIdApprovalChanges, Erc721or1155OperatorChanges } from '../SimulationSummary.js'
import { Erc721TokenApprovalChange, ERC20TokenApprovalChange } from '../../../types/visualizer-types.js'
import { TokenSymbol, TokenAmount } from '../../subcomponents/coins.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress, SmallAddress } from '../../subcomponents/address.js'
import { assertNever } from '../../../utils/typescript.js'
import { getDeployedContractAddress } from '../../../simulation/services/SimulationModeEthereumClientService.js'
import { addressString } from '../../../utils/bigint.js'
import { extractEnsEvents, extractTokenEvents } from '../../../background/metadataUtils.js'
import { EnsEventsExplainer } from './EnsEventExplainer.js'
import { TokenVisualizerErc20Event, TokenVisualizerErc721Event, TokenVisualizerNFTAllApprovalEvent, TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'
import { removeDuplicates } from '../../ui-utils.js'

type SendOrReceiveTokensImportanceBoxParams = {
	sending: boolean,
	tokenVisualizerResults: TokenVisualizerResultWithMetadata[],
	textColor: string,
	renameAddressCallBack: RenameAddressCallBack,
}

export function tokenEventToTokenSymbolParams(tokenEvent: TokenVisualizerResultWithMetadata){
	switch(tokenEvent.type) {
		case 'ERC1155': return { tokenEntry: tokenEvent.token, tokenId: tokenEvent.tokenId, tokenIdName: tokenEvent.tokenIdName }
		case 'ERC20': return { tokenEntry: tokenEvent.token }
		case 'ERC721': return  { tokenEntry: tokenEvent.token, tokenId: tokenEvent.tokenId }
		case 'NFT All approval':  {
			if (tokenEvent.token.type === 'ERC1155') return { tokenEntry: tokenEvent.token, tokenId: undefined, tokenIdName: undefined }
			return { tokenEntry: tokenEvent.token, tokenId: undefined }
		}
		default: assertNever(tokenEvent)
	}
}

function SendOrReceiveTokensImportanceBox(param: SendOrReceiveTokensImportanceBoxParams) {
	return <>
		{ param.tokenVisualizerResults.map((tokenEvent) => (
			tokenEvent.isApproval ? <></> : <div class = 'vertical-center'>
				<div class = { `box token-box ${ param.sending ? 'negative-box' : 'positive-box' } vertical-center` } style = 'display: inline-block'>
					<table class = 'log-table'>
						<div class = 'log-cell'>
							<p class = 'ellipsis paragraph' style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
								{ param.sending ? 'Send' : 'Receive' }&nbsp;
							</p>
						</div>
						<div class = 'log-cell'>
							{ 'amount' in tokenEvent ?
								<TokenAmount
									amount = { tokenEvent.amount }
									{ ...'tokenId' in tokenEvent ? { tokenId: tokenEvent.tokenId } : {} }
									tokenEntry = { tokenEvent.token }
									style = { { color: param.textColor } }
									fontSize = 'normal'
								/>
							: <></>}
						</div>
						<div class = 'log-cell'>
							<TokenSymbol
								{ ...tokenEventToTokenSymbolParams(tokenEvent) }
								style = { { color: param.textColor } }
								useFullTokenName = { false }
								renameAddressCallBack = { param.renameAddressCallBack }
								fontSize = 'normal'
							/>
						</div>
						<div class = 'log-cell'>
							<p class = 'ellipsis paragraph' style = { `color: ${ param.textColor }; margin-bottom: 0px; display: inline-block` }>
								{ param.sending ? 'to' : 'from' }
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
	const tokenResults = extractTokenEvents(param.simTx.events)
	const ensEvents = extractEnsEvents(param.simTx.events)

	const tokenSendersAndReceivers = removeDuplicates(tokenResults.flatMap((tokenResult) => [
		...tokenResult.from.address === msgSender || tokenResult.from.useAsActiveAddress ? [tokenResult.from] : [],
		...tokenResult.to.address === msgSender || tokenResult.to.useAsActiveAddress ? [tokenResult.to] : []
	]))
	const eventTypesForEachAccount = tokenSendersAndReceivers.map((currentAddress) => {
		const sendingTokenResults = tokenResults.filter((x) => x.from.address === currentAddress.address)
		const receivingTokenResults = tokenResults.filter((x) => x.to.address === currentAddress.address)
		const erc20TokenApprovalChanges: ERC20TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerErc20Event => x.isApproval && x.type === 'ERC20').map((entry) => {
			return { ...entry.token, approvals: [ {...entry.to, change: entry.amount } ] }
		})

		const operatorChanges: (Erc721OperatorChange | Erc1155OperatorChange)[] = sendingTokenResults.filter((x): x is TokenVisualizerNFTAllApprovalEvent => x.type === 'NFT All approval').map((entry) => {
			return { ...entry.token, operator: 'allApprovalAdded' in entry && entry.allApprovalAdded ? entry.to : undefined }
		})

		// token address, tokenId, approved address
		const tokenIdApprovalChanges: Erc721TokenApprovalChange[] = sendingTokenResults.filter((x): x is TokenVisualizerErc721Event => 'tokenId' in x && x.isApproval).map((entry) => {
			return { tokenEntry: entry.token, tokenId: entry.tokenId, approvedEntry: entry.to }
		})
		return {
			currentAddress,
			sendingTokenResults,
			receivingTokenResults,
			erc20TokenApprovalChanges,
			operatorChanges,
			tokenIdApprovalChanges
		}
	})

	if (param.simTx.transaction.to !== undefined
		&& param.simTx.transaction.value === 0n
		&& eventTypesForEachAccount.length === 0
		&& ensEvents.length === 0
	) {
		return <div class = 'notification transaction-importance-box'>
			<p class = 'paragraph'> { param.simTx.events.length === 0 ? 'The transaction does no visible important changes to your accounts.' : `The transaction does no visible important changes to your accounts, HOWEVER, it produces ${ param.simTx.events.length } event${ param.simTx.events.length === 1 ? '' : 's' }.`}</p>
		</div>
	}

	const textColor = 'var(--text-color)'

	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content' >
			{ /* contract creation */}
			<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
				{ param.simTx.transaction.to !== undefined ? <></> :
					<p class = 'paragraph'> { `A contract is deployed to address ${ addressString(getDeployedContractAddress(param.simTx.transaction.from.address, param.simTx.transaction.nonce)) }` }</p>
				}
			</div>
			{ /* ENS events */ }
			<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
				<EnsEventsExplainer
					ensEvents = { ensEvents }
					textColor = { textColor }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					rpcNetwork = { param.rpcNetwork }
				/>
			</div>
		</div>
		{ (param.simTx.transaction.to === undefined || ensEvents.length > 0) && eventTypesForEachAccount.length > 0 ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
		{ eventTypesForEachAccount.map((eventsGrouped, index) => <div>
			<BigAddress
				addressBookEntry = { eventsGrouped.currentAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
				style = { { '--bg-color': '#6d6d6d' } }
			/>
			<div style = 'display: grid; grid-template-rows: max-content max-content' >
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<SendOrReceiveTokensImportanceBox
						tokenVisualizerResults = { eventsGrouped.sendingTokenResults.filter((x) => !x.isApproval) }
						sending = { true }
						textColor = { textColor }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>

				{ /* us approving other addresses */ }
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<Erc20ApprovalChanges
						erc20TokenApprovalChanges = { eventsGrouped.erc20TokenApprovalChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<Erc721or1155OperatorChanges
						erc721or1155OperatorChanges = { eventsGrouped.operatorChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<Erc721TokenIdApprovalChanges
						Erc721TokenIdApprovalChanges = { eventsGrouped.tokenIdApprovalChanges }
						textColor = { textColor }
						negativeColor = { textColor }
						isImportant = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>

				{ /* receiving tokens */ }
				<div class = 'log-cell' style = 'justify-content: left; display: grid;'>
					<SendOrReceiveTokensImportanceBox
						tokenVisualizerResults = { eventsGrouped.receivingTokenResults.filter((x) => !x.isApproval) }
						sending = { false }
						textColor = { textColor }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>
			</div>
			{ index + 1 !== eventTypesForEachAccount.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
		</div> ) }
	</div>
}
