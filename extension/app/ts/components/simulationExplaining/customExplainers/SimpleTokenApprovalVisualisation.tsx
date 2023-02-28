import { RenameAddressCallBack } from '../../../utils/user-interface-types.js'
import { BigAddress } from '../../subcomponents/address.js'
import { Token721AmountField, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { GasFee } from '../SimulationSummary.js'
import { SimulatedAndVisualizedSimpleApprovalTransaction } from '../identifyTransaction.js'

export function SimpleTokenApprovalVisualisation({ transaction, renameAddressCallBack }: { transaction: SimulatedAndVisualizedSimpleApprovalTransaction, renameAddressCallBack: RenameAddressCallBack }) {
	const approval = transaction.tokenResults[0]
	const textColor = 'var(--negative-color)'

	return <div class = 'notification transaction-importance-box'>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> Allow &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<BigAddress
				addressBookEntry = { approval.to }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
		<span style = 'grid-template-columns: auto auto; display: grid;'>
			<p class = 'paragraph' style = 'font-size: 28px; font-weight: 500; justify-self: right;'> To Spend &nbsp;</p>
		</span>
		<div class = 'box' style = 'background-color: var(--alpha-005); box-shadow: unset; margin-bottom: 0px;'>
			<span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'>
				<div class = 'log-cell' style = 'justify-content: right;'>
					{ approval.is721 ?
						<Token721AmountField
							{ ...approval }
							textColor = { textColor }
							style = { { 'font-size': '28px', 'font-weight': '500' } }
						/>
					: <> { approval.amount >= (2n ** 96n - 1n ) ?
							<p class = 'ellipsis' style = { `color: ${ textColor }; font-size: 28px; font-weight: 500` }><b>ALL</b></p>
						:
							<TokenAmount
								amount = { approval.amount }
								decimals = { approval.token.decimals }
								textColor = { textColor }
								style = { { 'font-size': '28px', 'font-weight': '500' } }
							/>
						} </>
					}
				</div>
				<div class = 'log-cell' style = 'padding-right: 0.2em'>
					<TokenSymbol
						{ ...approval.token }
						textColor = { textColor }
						useFullTokenName = { false }
						style = { { 'font-size': '28px', 'font-weight': '500' } }
					/>
				</div>
			</span>
		</div>
		<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content; margin-top: 5px;'>
			<GasFee tx = { transaction } chain = { transaction.chainId } />
		</span>
	</div>
}
