import { DistributedOmit, assertNever } from '../../../utils/typescript.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress, SmallAddress } from '../../subcomponents/address.js'
import { TokenOrEth, TokenOrEtherParams } from '../../subcomponents/coins.js'
import { GasFee, TransactionGasses } from '../SimulationSummary.js'
import { SimulatedAndVisualizedSimpleTokenTransferTransaction } from '../identifyTransaction.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import { RpcNetwork } from '../../../types/rpc.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../../utils/constants.js'
import { interleave } from '../../../utils/typed-arrays.js'
import { extractTokenEvents } from '../../../background/metadataUtils.js'
import { TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'

export type BeforeAfterAddress = {
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
		<BigAddress addressBookEntry = { address } renameAddressCallBack = { renameAddressCallBack } style = { { '--bg-color' : '#757575' } } />
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
	viaProxypath?: readonly AddressBookEntry[]
	asset: TokenOrEtherParams
	sender: BeforeAfterAddress
	receiver: BeforeAfterAddress
	renameAddressCallBack: RenameAddressCallBack
}

export function SimpleSend({ transaction, asset, sender, receiver, renameAddressCallBack, viaProxypath } : SimpleSendParams) {
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
		<span class = 'log-table' style = { { display: 'inline-flex', marginTop: '5px' } }>
			<GasFee tx = { transaction } rpcNetwork = { transaction.rpcNetwork } />
		</span>
		{ viaProxypath === undefined ? <></> : <div style = 'display: flex;'>
			<p class = 'paragraph' style = { 'color: var(--subtitle-text-color)' }> Via proxy:&nbsp;</p>
			<> { interleave(viaProxypath.map((addressBookEntry) => <SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { renameAddressCallBack }/>), <p class = 'paragraph' style = { 'color: var(--subtitle-text-color)' }>&nbsp;{ '-> '}&nbsp;</p>) } </>
		</div> }
	</div>
}

export const getAsset = (transfer: TokenVisualizerResultWithMetadata, renameAddressCallBack: RenameAddressCallBack) => {
	switch (transfer.type) {
		case 'ERC1155': return { ...tokenEventToTokenSymbolParams(transfer), amount: transfer.amount, renameAddressCallBack }
		case 'ERC20': return { ...tokenEventToTokenSymbolParams(transfer), amount: transfer.amount, renameAddressCallBack }
		case 'ERC721': return { ...tokenEventToTokenSymbolParams(transfer), received: false, renameAddressCallBack }
		case 'NFT All approval': return undefined
		default: assertNever(transfer)
	}
}

export function SimpleTokenTransferVisualisation({ simTx, renameAddressCallBack }: { simTx: SimulatedAndVisualizedSimpleTokenTransferTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	const transfer = extractTokenEvents(simTx.events)[0]
	if (transfer === undefined) throw new Error('transfer was undefined')
	const asset = getAsset(transfer, renameAddressCallBack)
	if (asset === undefined) throw new Error('asset was undefined')
	const senderAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.from.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
	const receiverAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.to.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
	const senderGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && transfer.from.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
	const receiverGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && transfer.to.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)

	return <SimpleSend
		transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
		asset = { { ...asset, useFullTokenName: false, fontSize: 'normal' } }
		sender = { {
			address: transfer.from,
			beforeAndAfter : senderAfter === undefined || !('amount' in asset) ? undefined : { before: senderAfter + asset.amount + senderGasFees, after: senderAfter },
		} }
		receiver = { {
			address: transfer.to,
			beforeAndAfter : receiverAfter === undefined || !('amount' in asset) ? undefined : { before: receiverAfter + receiverGasFees - asset.amount, after: receiverAfter },
		} }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}
