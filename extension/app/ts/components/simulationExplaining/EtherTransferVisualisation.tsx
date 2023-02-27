import { AddressBookEntry, CHAIN, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { SimulatedAndVisualizedTransaction, EthBalanceChangesWithMetadata } from '../../utils/visualizer-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { Ether } from '../subcomponents/coins.js'
import { GasFee } from './SimulationSummary.js'

export function EtherTransferAddress({ address, before, after, renameAddressCallBack, chainId }: { address: AddressBookEntry, before: bigint, after: bigint, renameAddressCallBack: RenameAddressCallBack, chainId: CHAIN }) {
	return <>
		<BigAddress
			addressBookEntry = { address }
			renameAddressCallBack = { renameAddressCallBack }
		/>

		<span style = 'grid-template-columns: auto auto; display: grid; justify-content: space-between; margin-top: 10px'>
			<span style = 'grid-template-columns: auto; display: grid;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color);'> Before:</p>
				<Ether
					amount = { before }
					chain = { chainId }
					useFullTokenName = { false }
				/>
			</span>
			<span style = 'grid-template-columns: auto; display: grid;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color);'> After:</p>
				<Ether
					amount = { after }
					chain = { chainId }
					useFullTokenName = { false }
				/>
			</span>
		</span>
	</>
}

function getBeforeAndAfterBalanceForAddress(ethBalances: readonly EthBalanceChangesWithMetadata[], address: bigint) {
	const filtered = ethBalances.filter((x) => x.address.address === address)
	if (filtered.length === 0) {
		return {
			before: 0n,
			after: 0n,
		}
	}
	return {
		before: filtered[0].before,
		after: filtered[filtered.length - 1].after,
	}
}

export function EtherTransferVisualisation({ transaction, renameAddressCallBack }: { transaction: SimulatedAndVisualizedTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	if (transaction.to === undefined) return <></>
	console.log(transaction)
	const senderBalanceChanges = getBeforeAndAfterBalanceForAddress(transaction.ethBalanceChanges, transaction.from.address)
	const receiverBalanceChanges = getBeforeAndAfterBalanceForAddress(transaction.ethBalanceChanges, transaction.to.address)
	if (senderBalanceChanges === undefined || receiverBalanceChanges === undefined) return <></>

	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Send&nbsp;</p>
			<Ether
				amount = { transaction.value }
				chain = { transaction.chainId }
				useFullTokenName = { false }
				style = { { 'font-size': '28px', 'font-weight': '500' } }
			/>
		</span>
		<p class = 'paragraph'> From </p>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<EtherTransferAddress
				address = { transaction.from }
				before = { senderBalanceChanges.before }
				after = { senderBalanceChanges.after }
				renameAddressCallBack = { renameAddressCallBack }
				chainId = { transaction.chainId }
			/>
		</div>
		<p class = 'paragraph'> To </p>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<EtherTransferAddress
				address = { transaction.to }
				before = { receiverBalanceChanges.before }
				after = { receiverBalanceChanges.after }
				renameAddressCallBack = { renameAddressCallBack }
				chainId = { transaction.chainId }
			/>
		</div>
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { transaction } chain = { transaction.chainId } />
		</span>
	</div>
}
