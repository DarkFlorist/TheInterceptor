import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedProxyTokenTransferTransaction } from '../identifyTransaction.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../../utils/constants.js'
import { SimpleSend, getAsset } from './SimpleSendVisualisations.js'

export function ProxyTokenTransferVisualisation({ simTx, renameAddressCallBack }: { simTx: SimulatedAndVisualizedProxyTokenTransferTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	const transfer = simTx.tokenResults[0]
	const receiver = simTx.transferRoute[simTx.transferRoute.length - 1]
	if (transfer === undefined) throw new Error('transfer was undefined')
	if (receiver === undefined) throw new Error('receiver was undefined')
	const asset = getAsset(transfer, renameAddressCallBack)
	const senderAfter = simTx.tokenBalancesAfter.find((change) => change.owner === transfer.from.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
	const receiverAfter = simTx.tokenBalancesAfter.find((change) => change.owner === receiver.address && change.token === asset.tokenEntry.address && change.tokenId === asset.tokenId)?.balance
	const senderGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && transfer.from.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
	const receiverGasFees = (asset.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS && asset.tokenEntry.type === 'ERC20' && receiver.address === simTx.transaction.from.address ? simTx.gasSpent * simTx.realizedGasPrice : 0n)
	
	return <SimpleSend
		viaProxypath = { simTx.transferRoute.slice(0, -1) }
		transaction = { { ...simTx, rpcNetwork: simTx.transaction.rpcNetwork } }
		asset = { { ...asset, useFullTokenName: false, fontSize: 'normal' } }
		sender = { {
			address: transfer.from,
			beforeAndAfter : senderAfter === undefined || !('amount' in asset) ? undefined : { before: senderAfter + asset.amount + senderGasFees, after: senderAfter },
		} }
		receiver = { {
			address: receiver,
			beforeAndAfter : receiverAfter === undefined || !('amount' in asset) ? undefined : { before: receiverAfter + receiverGasFees - asset.amount, after: receiverAfter },
		} }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}
