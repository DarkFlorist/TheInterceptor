import { EnrichedEthereumInputData } from '../../types/EnrichedEthereumData.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { ParsedInputData } from '../simulationExplaining/Transactions.js'
import { ViewSelector } from './ViewSelector.js'
import { SmallAddress } from './address.js'

type TransactionInputParams = {
	addressMetaData: readonly AddressBookEntry[]
	parsedInputData: EnrichedEthereumInputData
	input: Uint8Array
	to: AddressBookEntry | undefined
	renameAddressCallBack: RenameAddressCallBack
}
export function TransactionInput({ parsedInputData, input, to, addressMetaData, renameAddressCallBack }: TransactionInputParams) {
	return <ViewSelector id = 'transaction_input'>
		{ parsedInputData?.type === 'Parsed' ? ( <>
			<ViewSelector.List>
				<ViewSelector.View title = 'View Parsed' value = 'parsed'>
					<ParsedInputData inputData = { parsedInputData } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack }/>
				</ViewSelector.View>
				<ViewSelector.View title = 'View Raw' value = 'raw'>
					<pre>{ dataStringWith0xStart(input) }</pre>
				</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</> ) : <>
			<ViewSelector.List>
				<ViewSelector.View title = 'View Parsed' value = 'parsed'> 
					<div style = 'display: flex;'>
						{ to !== undefined ? <>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>No ABI available for&nbsp;</p>
								<SmallAddress addressBookEntry = { to} renameAddressCallBack = { renameAddressCallBack } />
						</> : <>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>No ABI available</p>
						</> }
					</div>
				</ViewSelector.View>
				<ViewSelector.View title = 'View Raw' value = 'raw'>
					<pre>{ dataStringWith0xStart(input) }</pre>
				</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</> }
	</ViewSelector>
}
