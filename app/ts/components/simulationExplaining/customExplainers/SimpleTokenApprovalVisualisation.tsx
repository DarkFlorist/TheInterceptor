import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { AllApproval, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee, TransactionGasses } from '../SimulationSummary.js'
import { tokenEventToTokenSymbolParams } from './CatchAllVisualizer.js'
import { RpcNetwork } from '../../../types/rpc.js'
import { TokenVisualizerResultWithMetadata } from '../../../types/EnrichedEthereumData.js'

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
							style = { { 'font-weight': '500', color: textColor } }
							fontSize = 'big'
						/>
					: <> { 'amount' in params.approval && params.approval.amount >= (2n ** 96n - 1n ) ?
							<p class = 'ellipsis' style = { `color: ${ textColor }; font-size: 28px; font-weight: 500` }><b>ALL</b></p>
						:
							'amount' in params.approval ?
								<TokenAmount
									amount = { params.approval.amount }
									tokenEntry = { params.approval.token }
									style = { { 'font-weight': '500', color: textColor } }
									fontSize = 'big'
								/>
							: <></>
						} </>
					}
				</div>
				<div class = 'log-cell'>
					<TokenSymbol
						{ ...tokenEventToTokenSymbolParams(params.approval) }
						useFullTokenName = { false }
						style = { { 'font-weight': '500', color: textColor } }
						renameAddressCallBack = { params.renameAddressCallBack }
						fontSize = 'big'
					/>
				</div>
			</span>
		</div>
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { params.transactionGasses } rpcNetwork = { params.rpcNetwork } />
		</span>
	</div>
}
