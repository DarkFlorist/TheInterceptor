import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { SafeTx } from '../../types/personal-message-definitions.js'
import type { RpcNetwork } from '../../types/rpc.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { bigintToDecimalString } from '../../utils/bigint.js'
import { CHAIN_NAMES } from '../../utils/chainNames.js'
import { CellElement } from '../ui-utils.js'
import { SmallAddress } from './address.js'
import { Ether } from './coins.js'

type SafeTxSigningHashes = {
	readonly domainHash: string
	readonly messageHash: string
	readonly safeTxHash: string
}

type SafeTxSigningAddressBookEntries = {
	readonly verifyingContract: AddressBookEntry
	readonly to: AddressBookEntry
	readonly gasToken: AddressBookEntry
	readonly refundReceiver: AddressBookEntry
}

type SafeTxSigningDetailsParams = {
	safeTx: SafeTx
	hashes: SafeTxSigningHashes
	addressBookEntries: SafeTxSigningAddressBookEntries
	// Undefined when the network is not known to the popup; the value is then shown without a token symbol.
	rpcNetwork: RpcNetwork | undefined
	renameAddressCallBack: RenameAddressCallBack
}

// A hardware signer shows the numeric EIP-712 chainId, so keep it visible next to the human-readable name.
function getChainNameWithId(chainId: bigint) {
	const chainName = CHAIN_NAMES.get(chainId.toString(10))
	return chainName === undefined ? chainId.toString(10) : `${ chainName } (${ chainId.toString(10) })`
}

function SigningHash({ label, hash }: { label: string, hash: string }) {
	return <>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ label }</p>
		<p class = 'paragraph text-legible' style = 'overflow-wrap: anywhere'>{ hash }</p>
	</>
}

// The EIP-712 SafeTx fields and hashes in the order a hardware signer lists them, so the user can compare the two side by side.
export function SafeTxSigningDetails({ safeTx, hashes, addressBookEntries, rpcNetwork, renameAddressCallBack }: SafeTxSigningDetailsParams) {
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			<CellElement text = 'Gnosis Safe: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { addressBookEntries.verifyingContract } renameAddressCallBack = { renameAddressCallBack } /> }/>
			{ safeTx.domain.chainId !== undefined
				? <>
					<CellElement text = 'Chain: '/>
					<CellElement text = { getChainNameWithId(BigInt(safeTx.domain.chainId)) }/>
				</>
				: <></>
			}
			<CellElement text = 'To: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { addressBookEntries.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'Value: '/>
			<CellElement text = { rpcNetwork === undefined ? `${ bigintToDecimalString(safeTx.message.value, 18n) } (native token)` : <Ether amount = { safeTx.message.value } rpcNetwork = { rpcNetwork } fontSize = 'normal'/> }/>
			<CellElement text = 'Value (wei): '/>
			<CellElement text = { safeTx.message.value.toString(10) }/>
			<CellElement text = 'Operation: '/>
			<CellElement text = { safeTx.message.operation.toString(10) }/>
			<CellElement text = 'Gnosis Safe Transaction Gas: '/>
			<CellElement text = { safeTx.message.safeTxGas.toString(10) }/>
			<CellElement text = 'Base Gas: '/>
			<CellElement text = { safeTx.message.baseGas.toString(10) }/>
			<CellElement text = 'Gas Price: '/>
			<CellElement text = { safeTx.message.gasPrice.toString(10) }/>
			{ safeTx.message.gasToken !== 0n
				? <>
					<CellElement text = 'Gas Token: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { addressBookEntries.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			{ safeTx.message.refundReceiver !== 0n
				? <>
					<CellElement text = 'Refund Receiver: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { addressBookEntries.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'Nonce: '/>
			<CellElement text = { safeTx.message.nonce.toString(10) }/>
		</span>
		<div class = 'textbox' style = 'margin-top: 10px'>
			<SigningHash label = 'Domain Hash' hash = { hashes.domainHash }/>
			<SigningHash label = 'Message Hash' hash = { hashes.messageHash }/>
			<SigningHash label = 'Gnosis Safe Transaction Hash' hash = { hashes.safeTxHash }/>
		</div>
	</>
}
