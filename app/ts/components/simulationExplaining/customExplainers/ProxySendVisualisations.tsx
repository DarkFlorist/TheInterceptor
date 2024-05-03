import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedProxyTokenTransferTransaction } from '../identifyTransaction.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../../utils/constants.js'
import { AddressBeforeAfter, BeforeAfterAddress, SimpleSend, getAsset } from './SimpleSendVisualisations.js'
import { GasFee, TransactionGasses } from '../SimulationSummary.js'
import { TokenOrEth, TokenOrEtherParams } from '../../subcomponents/coins.js'
import { RpcNetwork } from '../../../types/rpc.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { interleave } from '../../../utils/typed-arrays.js'
import { SmallAddress } from '../../subcomponents/address.js'

type BeforeAfterAddressWithAmount = BeforeAfterAddress & { amount: bigint }

type ProxyMultiSendParams = {
	transaction: TransactionGasses & { rpcNetwork: RpcNetwork }
	viaProxypath?: readonly AddressBookEntry[]
	asset: TokenOrEtherParams
	sender: BeforeAfterAddress
	receivers: readonly BeforeAfterAddressWithAmount[]
	renameAddressCallBack: RenameAddressCallBack
}

function ProxyMultiSend({ transaction, asset, sender, receivers, renameAddressCallBack, viaProxypath } : ProxyMultiSendParams) {
	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto auto auto; justify-content: center; display: grid; align-items: baseline;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Send&nbsp;</p>
			<TokenOrEth { ...asset } useFullTokenName = { false } style = { { 'font-weight': '500' } } fontSize = 'big' />
		</span>
		<p class = 'paragraph'> From </p>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<AddressBeforeAfter { ...sender } renameAddressCallBack = { renameAddressCallBack } tokenOrEtherDefinition = { asset } />
		</div>
		<p class = 'paragraph'> To </p>
		{ receivers.map((receiver) => <>
			<span style = 'grid-template-columns: auto auto auto auto; justify-content: center; display: grid; align-items: baseline;'>
				<p class = 'paragraph' style = 'justify-self: right;'> Receive&nbsp;</p>
				<TokenOrEth { ...{ ...asset, ...('amount' in asset ? { amount: receiver.amount } : {}) } } useFullTokenName = { false } />
			</span>
			<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
				<AddressBeforeAfter { ...receiver } renameAddressCallBack = { renameAddressCallBack } tokenOrEtherDefinition = { { ...asset, ...('amount' in asset ? { amount: receiver.amount } : {}) } }/>
			</div>
		</>) }
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { transaction } rpcNetwork = { transaction.rpcNetwork } />
		</span>
		{ viaProxypath === undefined ? <></> : <span style = 'display: flex;'>
			<p class = 'paragraph' style = { 'color: var(--subtitle-text-color)' }> Via proxy:&nbsp;</p>
			<> { interleave(viaProxypath.map((addressBookEntry) => <SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { renameAddressCallBack }/>), <p class = 'paragraph' style = { 'color: var(--subtitle-text-color)' }>&nbsp;{ ','}&nbsp;</p>) } </>
		</span> }
	</div>
}


export function ProxyTokenTransferVisualisation({ simTx, renameAddressCallBack }: { simTx: SimulatedAndVisualizedProxyTokenTransferTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	// proxy send to multiple addresses
	const transfer = simTx.tokenResults[0]
	if (transfer === undefined) throw new Error('transfer was undefined')
	const asset = getAsset(transfer, renameAddressCallBack)
	const senderAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.from.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
	const senderGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && transfer.from.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
	
	if (simTx.transferedTo.length === 1) {
		// proxy send to a single address
		const receiver = simTx.transferedTo[0]?.entry
		if (receiver === undefined) throw new Error('receiver was undefined')
		const receiverAfter = simTx.tokenBalancesAfter.find((change) => change.owner === receiver.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
		const receiverGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && receiver.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
		return <SimpleSend
			viaProxypath = { simTx.transferRoute }
			transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
			asset = { { ...asset, useFullTokenName: false, fontSize: 'normal' } }
			sender = { {
				address: transfer.from,
				beforeAndAfter: senderAfter === undefined || !('amount' in asset) ? undefined : { before: senderAfter + asset.amount + senderGasFees, after: senderAfter },
			} }
			receiver = { {
				address: receiver,
				beforeAndAfter: receiverAfter === undefined || !('amount' in asset) ? undefined : { before: receiverAfter + receiverGasFees - asset.amount, after: receiverAfter },
			} }
			renameAddressCallBack = { renameAddressCallBack }
		/>
	}
	return <ProxyMultiSend
		viaProxypath = { simTx.transferRoute }
		transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
		asset = { { ...asset, useFullTokenName: false, fontSize: 'normal' } }
		sender = { {
			address: transfer.from,
			beforeAndAfter: senderAfter === undefined || !('amount' in asset) ? undefined : { before: senderAfter + asset.amount + senderGasFees, after: senderAfter },
		} }
		receivers = { simTx.transferedTo.map((destination) => {
			const receiverAfter = simTx.tokenBalancesAfter.find((change) => change.owner === destination.entry.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
			const receiverGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && destination.entry.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
			return {
				address: destination.entry,
				amount: destination.amountDelta,
				beforeAndAfter : receiverAfter === undefined || !('amount' in asset) ? undefined : { before: receiverAfter + receiverGasFees - destination.amountDelta, after: receiverAfter },
			}
		}) }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}
