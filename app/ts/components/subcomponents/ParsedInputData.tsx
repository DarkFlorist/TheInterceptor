import { EnrichedEthereumInputData } from '../../types/EnrichedEthereumData.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { ParsedInputData } from '../simulationExplaining/Transactions.js'
import { ViewSelector } from './ViewSelector.js'
import { SmallAddress } from './address.js'



export function NoParsedAvailable({ to, renameAddressCallBack }: { to: AddressBookEntry | undefined, renameAddressCallBack: RenameAddressCallBack }) {
	if (to?.abi === undefined) {
		if (to === undefined) return <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>No ABI available</p>
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>No ABI available for&nbsp;
			<SmallAddress addressBookEntry = { to } renameAddressCallBack = { renameAddressCallBack } />
		</p>
	} // We don't have support for parsing struct atm: https://github.com/DarkFlorist/TheInterceptor/issues/737
	if (to === undefined) return <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Unable to parse input data (it probably contains a struct)</p>
	return <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Unable to parse input data (it probably contains a struct) for&nbsp;
		<SmallAddress addressBookEntry = { to } renameAddressCallBack = { renameAddressCallBack } />
	</p>
}

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
				<ViewSelector.View title = 'View Parsed' value = 'parsed' isActive = { true }>
					<ParsedInputData inputData = { parsedInputData } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack }/>
				</ViewSelector.View>
				<ViewSelector.View title = 'View Raw' value = 'raw' isActive = { false }>
					<pre>{ dataStringWith0xStart(input) }</pre>
				</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</> ) : <>
			<ViewSelector.List>
				<ViewSelector.View title = 'View Parsed' value = 'parsed' isActive = { false }>
					<div style = 'display: flex;'>
						<NoParsedAvailable to = { to } renameAddressCallBack = { renameAddressCallBack } />
					</div>
				</ViewSelector.View>
				<ViewSelector.View title = 'View Raw' value = 'raw' isActive = { true }>
					<pre>{ dataStringWith0xStart(input) }</pre>
				</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</> }
	</ViewSelector>
}
