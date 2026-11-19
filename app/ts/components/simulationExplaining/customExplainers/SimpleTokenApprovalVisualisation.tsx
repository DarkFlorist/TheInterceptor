import type { ComponentChildren } from 'preact'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, type TransactionGasses } from '../SimulationSummary.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import type { RpcNetwork } from '../../../types/rpc.js'
import type { TokenApprovalDisplay, TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'
import type { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { isUnlimitedErc20Approval } from '../../../utils/erc20.js'
import { tokenEventGrantsSpendingRights } from '../../../utils/approvals.js'
import { getToneClass } from '../../ui-utils.js'

type SimpleTokenApprovalVisualisation = {
	approval: TokenVisualizerResultWithMetadata
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

type TokenApprovalsVisualisationParams = {
	spender: AddressBookEntry
	approvals: readonly TokenApprovalDisplay[]
	// Whether the approvals hand spending rights to the spender or take them away (tokenEventGrantsSpendingRights decides it for a token event).
	granted: boolean
	renameAddressCallBack: RenameAddressCallBack
	children?: ComponentChildren
}

const getApprovalToneClass = (granted: boolean) => `coin-text--strong ${ getToneClass('coin-text', granted ? 'negative' : 'positive') }`

function ApprovedTokenAmount({ approval, granted, renameAddressCallBack }: { approval: TokenApprovalDisplay, granted: boolean, renameAddressCallBack: RenameAddressCallBack }) {
	const toneClass = getApprovalToneClass(granted)
	return <span class = 'log-table approval-amount-table'>
		<div class = 'log-cell log-cell--right'>
			{ /* A removal names the token only: a zero allowance or "NONE" next to "Stop allowing" would read as a contradiction. */ }
			{ !granted ? <></> : approval.type === 'NFT All approval' ?
				<AllApproval
					{ ...approval }
					class = { toneClass }
					fontSize = 'big'
				/>
			: <> { 'amount' in approval && isUnlimitedErc20Approval(approval.amount) ?
					<p class = 'ellipsis approval-unlimited-amount'><b>ALL</b></p>
				:
					'amount' in approval ?
						<TokenAmount
							amount = { approval.amount }
							tokenEntry = { approval.token }
							class = { toneClass }
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
				class = { toneClass }
				renameAddressCallBack = { renameAddressCallBack }
				fontSize = 'big'
			/>
		</div>
	</span>
}

export function TokenApprovalsVisualisation(param: TokenApprovalsVisualisationParams) {
	// A single token's approval is removed by approving the zero address, so there is no spender to show for it.
	const [onlyApproval] = param.approvals
	const removesTokenIdApproval = !param.granted && param.approvals.length === 1 && onlyApproval?.type === 'ERC721'
	return <div class = 'notification transaction-importance-box'>
		{ removesTokenIdApproval ? <></> : <>
			<p class = 'summary-label'>{ param.granted ? 'Allow' : 'Stop allowing' }</p>
			<div class = 'box summary-leg'>
				<BigAddress
					addressBookEntry = { param.spender }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
		</> }
		<p class = 'summary-label'>{ removesTokenIdApproval ? 'Remove the approval for' : param.granted ? 'To spend' : 'From spending' }</p>
		<div class = 'box summary-leg'>
			{ param.approvals.map((approval, index) => <ApprovedTokenAmount key = { index } approval = { approval } granted = { param.granted } renameAddressCallBack = { param.renameAddressCallBack }/>) }
		</div>
		{ param.children }
	</div>
}

export function SimpleTokenApprovalVisualisation(param: SimpleTokenApprovalVisualisation) {
	return <TokenApprovalsVisualisation
		spender = { param.approval.to }
		approvals = { [param.approval] }
		granted = { tokenEventGrantsSpendingRights(param.approval) }
		renameAddressCallBack = { param.renameAddressCallBack }
	>
		<span class = 'log-table transaction-meta-row summary-meta'>
			<GasFee tx = { param.transactionGasses } rpcNetwork = { param.rpcNetwork } />
		</span>
	</TokenApprovalsVisualisation>
}
