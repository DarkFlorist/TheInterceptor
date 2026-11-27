import type { GnosisSafeTx } from '../../types/personal-message-definitions.js'
import type { GnosisSafeMessageReview } from '../../types/gnosisSafeReview.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { RpcNetwork } from '../../types/rpc.js'
import type { GnosisSafeTransactionSigningRequest } from '../../types/gnosisSafeTypes.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { getGnosisSafeTxSigningHashes } from '../../gnosisSafe/gnosisSafeCore.js'
import { decodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } from '../../gnosisSafe/gnosisSafeDelegateCalls.js'
import { matchesGnosisSafeMessageApproval } from '../../gnosisSafe/gnosisSafeMessageApproval.js'
import { addressString, bigintToDecimalString, bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { CollapsibleCard } from '../subcomponents/CollapsibleCard.js'
import { GnosisSafeTxSigningDetails } from '../subcomponents/GnosisSafeTxSigningDetails.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'

export function GnosisSafeProposalDetails({ safeTx, messageReview }: { safeTx: GnosisSafeTx, messageReview: GnosisSafeMessageReview | undefined }) {
	if (safeTx.message.operation !== 1n) return <></>
	if (safeTx.message.to === GNOSIS_SAFE_MULTI_SEND_CALL_ONLY) return <div class = 'textbox'>
		<p class = 'paragraph'>Atomic Gnosis Safe batch: all calls execute in order as the Gnosis Safe. If any call fails, the entire batch reverts.</p>
		{ decodeGnosisSafeBatch(safeTx.message.data).map((call, index) => <div key = { index }>
			<p class = 'paragraph'>{ index + 1 }. To: { addressString(call.to) }; value: { bigintToDecimalString(call.value, 18n) } ether</p>
			<p class = 'paragraph' style = 'overflow-wrap: anywhere'>Calldata: { dataStringWith0xStart(call.data) }</p>
		</div>) }
	</div>
	if (messageReview === undefined || !matchesGnosisSafeMessageApproval(safeTx.message, messageReview)) return <></>
	return <div class = 'textbox'>
		<p class = 'paragraph'>On-chain Gnosis Safe message approval. The message becomes approved only after this Gnosis Safe transaction is executed.</p>
		<p class = 'paragraph' style = 'white-space: pre-wrap'>{ messageReview.text }</p>
	</div>
}

type GnosisSafeProposalSigningRequestCardParams = {
	safeTransaction: GnosisSafeTransactionSigningRequest
	addressMetaData: readonly AddressBookEntry[]
	rpcNetwork: RpcNetwork | undefined
	renameAddressCallBack: RenameAddressCallBack
}

// Shows the EIP-712 GnosisSafeTx that "Sign & add" forwards to the signer wallet, so a hardware signer's display can be checked against it.
export function GnosisSafeProposalSigningRequestCard({ safeTransaction, addressMetaData, rpcNetwork, renameAddressCallBack }: GnosisSafeProposalSigningRequestCardParams) {
	const safeTx = safeTransaction.safeTx
	// safeTxHash is the contract-verified hash stored with the request; gnosisSafeCore.test.ts asserts it equals keccak256(0x1901 ‖ domainHash ‖ messageHash).
	const hashes = { ...getGnosisSafeTxSigningHashes(safeTx), safeTxHash: bytes32String(safeTransaction.safeTxHash) }
	const addressBookEntries = {
		verifyingContract: getAddressBookEntryOrAFiller(addressMetaData, safeTx.domain.verifyingContract),
		to: getAddressBookEntryOrAFiller(addressMetaData, safeTx.message.to),
		gasToken: getAddressBookEntryOrAFiller(addressMetaData, safeTx.message.gasToken),
		refundReceiver: getAddressBookEntryOrAFiller(addressMetaData, safeTx.message.refundReceiver),
	}
	return <CollapsibleCard title = 'Gnosis Safe signing request (EIP-712)'>
		<div class = 'card-content'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color); margin-bottom: 10px'>Your signer wallet is asked to sign this typed data. Compare the fields and hashes with what your hardware signer displays.</p>
			<GnosisSafeTxSigningDetails safeTx = { safeTx } hashes = { hashes } addressBookEntries = { addressBookEntries } rpcNetwork = { rpcNetwork } renameAddressCallBack = { renameAddressCallBack }/>
		</div>
	</CollapsibleCard>
}
