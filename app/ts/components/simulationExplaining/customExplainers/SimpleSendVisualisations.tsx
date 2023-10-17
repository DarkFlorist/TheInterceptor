import { DistributedOmit, assertNever } from '../../../utils/typescript.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { EthBalanceChangesWithMetadata } from '../../../types/visualizer-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { TokenOrEth, TokenOrEtherParams } from '../../subcomponents/coins.js'
import { GasFee, TransactionGasses } from '../SimulationSummary.js'
import { SimulatedAndVisualizedEtherTransferTransaction, SimulatedAndVisualizedSimpleTokenTransferTransaction, TokenResult } from '../identifyTransaction.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import { RpcNetwork } from '../../../types/rpc.js'

type BeforeAfterAddress = {
	address: AddressBookEntry
	beforeAndAfter: {
		before: bigint
		after: bigint
	} | undefined
}

type TransferAddressParams = BeforeAfterAddress & {
	renameAddressCallBack: RenameAddressCallBack
	tokenOrEtherDefinition: DistributedOmit<TokenOrEtherParams, 'amount'>
}

export function AddressBeforeAfter({ address, beforeAndAfter, renameAddressCallBack, tokenOrEtherDefinition }: TransferAddressParams) {
	return <>
		<BigAddress
			addressBookEntry = { address }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		{ beforeAndAfter === undefined
			? <></>
			: <span style = 'grid-template-columns: auto auto; display: grid; justify-content: space-between; margin-top: 10px'>
				<span style = 'grid-template-columns: auto; display: grid;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color);'> Before:</p>
					<TokenOrEth { ... { ...tokenOrEtherDefinition, amount: beforeAndAfter.before } }/>
				</span>
				<span style = 'grid-template-columns: auto; display: grid;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color);'> After:</p>
					<TokenOrEth { ... { ...tokenOrEtherDefinition, amount: beforeAndAfter.after } }/>
				</span>
			</span>
		}
	</>
}

type SimpleSendParams = {
	transaction: TransactionGasses & { rpcNetwork: RpcNetwork }
	asset: TokenOrEtherParams
	sender: BeforeAfterAddress
	receiver: BeforeAfterAddress
	renameAddressCallBack: RenameAddressCallBack
}

function SimpleSend({ transaction, asset, sender, receiver, renameAddressCallBack } : SimpleSendParams) {
	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto auto auto; justify-content: center; display: grid; align-items: baseline;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Send&nbsp;</p>
			<TokenOrEth
				{ ...asset }
				useFullTokenName = { false }
				style = { { 'font-weight': '500' } }
				fontSize = 'big'
			/>
		</span>
		<p class = 'paragraph'> From </p>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<AddressBeforeAfter
				{ ...sender }
				renameAddressCallBack = { renameAddressCallBack }
				tokenOrEtherDefinition = { asset }
			/>
		</div>
		<p class = 'paragraph'> To </p>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<AddressBeforeAfter
				{ ...receiver }
				renameAddressCallBack = { renameAddressCallBack }
				tokenOrEtherDefinition = { asset }
			/>
		</div>
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { transaction } rpcNetwork = { transaction.rpcNetwork } />
		</span>
	</div>
}

function getBeforeAndAfterBalanceForAddress(ethBalances: readonly EthBalanceChangesWithMetadata[], address: bigint) {
	const filtered = ethBalances.filter((x) => x.address.address === address)
	if (filtered.length === 0) return { before: 0n, after: 0n }
	const firstBalance = filtered[0]
	const lastBalance = filtered[filtered.length - 1]
	if (firstBalance === undefined || lastBalance === undefined) throw new Error('first or last balance were undefined')
	return {
		before: firstBalance.before,
		after: lastBalance.after,
	}
}

export function EtherTransferVisualisation({ simTx, renameAddressCallBack }: { simTx: SimulatedAndVisualizedEtherTransferTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	const senderBalanceChanges = getBeforeAndAfterBalanceForAddress(simTx.ethBalanceChanges, simTx.transaction.from.address)
	const receiverBalanceChanges = getBeforeAndAfterBalanceForAddress(simTx.ethBalanceChanges, simTx.transaction.to.address)
	if (senderBalanceChanges === undefined || receiverBalanceChanges === undefined) return <></>
	return <SimpleSend
		transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
		asset = { {
			amount: simTx.transaction.value,
			rpcNetwork: simTx.transaction.rpcNetwork,
			useFullTokenName: false,
			fontSize: 'normal'
		} }
		sender = { { beforeAndAfter: senderBalanceChanges, address: simTx.transaction.from } }
		receiver = { { beforeAndAfter: receiverBalanceChanges, address: simTx.transaction.to } }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}

export function SimpleTokenTransferVisualisation({ simTx, renameAddressCallBack }: { simTx: SimulatedAndVisualizedSimpleTokenTransferTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	const transfer = simTx.tokenResults[0]
	if (transfer === undefined) throw new Error('transfer was undefined')
	const getAsset = (transfer: TokenResult) => {
		switch (transfer.type) {
			case 'ERC1155': return { ...tokenEventToTokenSymbolParams(transfer), amount: transfer.amount, renameAddressCallBack }
			case 'ERC20': return { ...tokenEventToTokenSymbolParams(transfer), amount: transfer.amount, renameAddressCallBack }
			case 'ERC721': return { ...tokenEventToTokenSymbolParams(transfer), received: false, renameAddressCallBack }
			default: assertNever(transfer)
		}
	}
	const asset = getAsset(transfer)
	const senderAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.from.address && change.tokenId === asset.tokenId)?.balance
	const receiverAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.to.address && change.tokenId === asset.tokenId)?.balance
	return <SimpleSend
		transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
		asset = { {
			...asset,
			useFullTokenName: false,
			fontSize: 'normal'
		} }
		sender = { {
			address: transfer.from,
			beforeAndAfter : senderAfter === undefined || !('amount' in asset) ? undefined : { before: senderAfter + asset.amount, after: senderAfter },
		} }
		receiver = { {
			address: transfer.to,
			beforeAndAfter : receiverAfter === undefined || !('amount' in asset) ? undefined : { before: receiverAfter - asset.amount, after: receiverAfter },
		} }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}
