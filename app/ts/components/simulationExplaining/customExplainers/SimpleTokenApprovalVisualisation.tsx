import { RenameAddressCallBack } from '../../../utils/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, TransactionGasses } from '../SimulationSummary.js'
import { TokenVisualizerResultWithMetadata, RpcNetwork } from '../../../utils/visualizer-types.js'

type SimpleTokenApprovalVisualisation = {
	approval: TokenVisualizerResultWithMetadata
	renameAddressCallBack: RenameAddressCallBack
	transactionGasses: TransactionGasses
	rpcNetwork: RpcNetwork
}

export function SimpleTokenApprovalVisualisation(params: SimpleTokenApprovalVisualisation) {
	const textColor = 'var(--negative-color)'

	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Allow &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<BigAddress
				addressBookEntry = { params.approval.to }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> To Spend &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'>
				<div class = 'log-cell' style = 'justify-content: right;'>
					{ params.approval.type === 'NFT All approval' ?
						<AllApproval
							{ ...params.approval }
							textColor = { textColor }
							style = { { 'font-size': '28px', 'font-weight': '500' } }
						/>
					: <> { 'amount' in params.approval && params.approval.amount >= (2n ** 96n - 1n ) ?
							<p class = 'ellipsis' style = { `color: ${ textColor }; font-size: 28px; font-weight: 500` }><b>ALL</b></p>
						:
							'amount' in params.approval ?
								<TokenAmount
									amount = { params.approval.amount }
									decimals = { params.approval.token.decimals }
									textColor = { textColor }
									style = { { 'font-size': '28px', 'font-weight': '500' } }
								/>
							: null
						} </>
					}
				</div>
				<div class = 'log-cell' style = 'padding-right: 0.2em'>
					<TokenSymbol
						{ ...params.approval.token }
						textColor = { textColor }
						useFullTokenName = { false }
						style = { { 'font-size': '28px', 'font-weight': '500' } }
					/>
				</div>
			</span>
		</div>
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { params.transactionGasses } rpcNetwork = { params.rpcNetwork } />
		</span>
	</div>
}
