import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, type TransactionGasses } from '../SimulationSummary.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import type { RpcNetwork } from '../../../types/rpc.js'
import type { TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'
import { isUnlimitedErc20Approval } from '../../../utils/erc20.js'
import { tokenEventGrantsSpendingRights } from '../../../utils/approvals.js'
import { getToneClass } from '../../ui-utils.js'

type SimpleTokenApprovalVisualisation = {
	approval: TokenVisualizerResultWithMetadata
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

export function SimpleTokenApprovalVisualisation(param: SimpleTokenApprovalVisualisation) {
	const granted = tokenEventGrantsSpendingRights(param.approval)
	// A single token's approval is removed by approving the zero address, so there is no spender to show for it.
	const removesTokenIdApproval = !granted && param.approval.type === 'ERC721'
	const toneClass = `coin-text--strong ${ getToneClass('coin-text', granted ? 'negative' : 'positive') }`
	return <div class = 'notification transaction-importance-box'>
		{ removesTokenIdApproval ? <></> : <>
			<p class = 'summary-label'>{ granted ? 'Allow' : 'Stop allowing' }</p>
			<div class = 'box summary-leg'>
				<BigAddress
					addressBookEntry = { param.approval.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
		</> }
		<p class = 'summary-label'>{ removesTokenIdApproval ? 'Remove the approval for' : granted ? 'To spend' : 'From spending' }</p>
		<div class = 'box summary-leg'>
			<span class = 'log-table approval-amount-table'>
				<div class = 'log-cell log-cell--right'>
					{ /* A removal names the token only: a zero allowance or "NONE" next to "Stop allowing" would read as a contradiction. */ }
					{ !granted ? <></> : param.approval.type === 'NFT All approval' ?
						<AllApproval
							{ ...param.approval }
							class = { toneClass }
							fontSize = 'big'
						/>
					: <> { 'amount' in param.approval && isUnlimitedErc20Approval(param.approval.amount) ?
							<p class = 'ellipsis approval-unlimited-amount'><b>ALL</b></p>
						:
							'amount' in param.approval ?
								<TokenAmount
									amount = { param.approval.amount }
									tokenEntry = { param.approval.token }
									class = { toneClass }
									fontSize = 'big'
								/>
							: <></>
						} </>
					}
				</div>
				<div class = 'log-cell'>
						<TokenSymbol
							{ ...tokenEventToTokenSymbolParams(param.approval) }
							useFullTokenName = { false }
							class = { toneClass }
							renameAddressCallBack = { param.renameAddressCallBack }
							fontSize = 'big'
						/>
					</div>
				</span>
			</div>
			<span class = 'log-table transaction-meta-row summary-meta'>
				<GasFee tx = { param.transactionGasses } rpcNetwork = { param.rpcNetwork } />
			</span>
		</div>
	}
