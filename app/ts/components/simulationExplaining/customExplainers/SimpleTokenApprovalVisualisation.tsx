import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, type TransactionGasses } from '../SimulationSummary.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import type { RpcNetwork } from '../../../types/rpc.js'
import type { TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'
import { isUnlimitedErc20Approval } from '../../../utils/erc20.js'

type SimpleTokenApprovalVisualisation = {
	approval: TokenVisualizerResultWithMetadata
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

export function SimpleTokenApprovalVisualisation(param: SimpleTokenApprovalVisualisation) {
	const textColor = 'var(--danger-color)'

	return <div class = 'notification transaction-importance-box'>
		<p class = 'summary-label'>Allow</p>
			<div class = 'box summary-leg'>
				<BigAddress
					addressBookEntry = { param.approval.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
		<p class = 'summary-label'>To spend</p>
		<div class = 'box summary-leg'>
			<span class = 'log-table approval-amount-table'>
				<div class = 'log-cell log-cell--right'>
					{ param.approval.type === 'NFT All approval' ?
						<AllApproval
							{ ...param.approval }
							style = { { 'font-weight': '500', color: textColor } }
							fontSize = 'big'
						/>
					: <> { 'amount' in param.approval && isUnlimitedErc20Approval(param.approval.amount) ?
							<p class = 'ellipsis approval-unlimited-amount'><b>ALL</b></p>
						:
							'amount' in param.approval ?
								<TokenAmount
									amount = { param.approval.amount }
									tokenEntry = { param.approval.token }
									style = { { 'font-weight': '500', color: textColor } }
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
							style = { { 'font-weight': '500', color: textColor } }
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
