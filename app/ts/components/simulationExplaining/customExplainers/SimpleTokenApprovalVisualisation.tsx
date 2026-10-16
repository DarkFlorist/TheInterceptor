import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, type TransactionGasses } from '../SimulationSummary.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import type { RpcNetwork } from '../../../types/rpc.js'
import type { TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'
import type { AddressBookEntry } from '../../../types/addressBookTypes.js'

const approvalTextColor = 'var(--danger-color)'

type SimpleTokenApprovalVisualisation = {
	approval: TokenVisualizerResultWithMetadata
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

type TokenApprovalsVisualisationParams = {
	spender: AddressBookEntry
	approvals: readonly TokenVisualizerResultWithMetadata[]
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

function ApprovedTokenAmount({ approval, renameAddressCallBack }: { approval: TokenVisualizerResultWithMetadata, renameAddressCallBack: RenameAddressCallBack }) {
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			{ approval.type === 'NFT All approval' ?
				<AllApproval
					{ ...approval }
					style = { { 'font-weight': '500', color: approvalTextColor } }
					fontSize = 'big'
				/>
			: <> { 'amount' in approval && approval.amount >= (2n ** 96n - 1n ) ?
					<p class = 'ellipsis' style = { `color: ${ approvalTextColor }; font-size: 28px; font-weight: 500` }><b>ALL</b></p>
				:
					'amount' in approval ?
						<TokenAmount
							amount = { approval.amount }
							tokenEntry = { approval.token }
							style = { { 'font-weight': '500', color: approvalTextColor } }
							fontSize = 'big'
						/>
					: <></>
				} </>
			}
		</div>
		<div class = 'log-cell'>
			<TokenSymbol
				{ ...tokenEventToTokenSymbolParams(approval) }
				useFullTokenName = { false }
				style = { { 'font-weight': '500', color: approvalTextColor } }
				renameAddressCallBack = { renameAddressCallBack }
				fontSize = 'big'
			/>
		</div>
	</span>
}

export function TokenApprovalsVisualisation(param: TokenApprovalsVisualisationParams) {
	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Allow &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<BigAddress
				addressBookEntry = { param.spender }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		</div>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> To Spend &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			{ param.approvals.map((approval, index) => <ApprovedTokenAmount key = { index } approval = { approval } renameAddressCallBack = { param.renameAddressCallBack }/>) }
		</div>
		<span class = 'log-table' style = { { display: 'inline-flex', marginTop: '5px' } }>
			<GasFee tx = { param.transactionGasses } rpcNetwork = { param.rpcNetwork } />
		</span>
	</div>
}

export function SimpleTokenApprovalVisualisation(param: SimpleTokenApprovalVisualisation) {
	return <TokenApprovalsVisualisation
		spender = { param.approval.to }
		approvals = { [param.approval] }
		renameAddressCallBack = { param.renameAddressCallBack }
		transactionGasses = { param.transactionGasses }
		rpcNetwork = { param.rpcNetwork }
	/>
}
