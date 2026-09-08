import type { SafeTx } from '../../types/personal-message-definitions.js'
import type { SafeMessageReview } from '../../types/safeReview.js'
import { decodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY } from '../../safe/safeDelegateCalls.js'
import { matchesSafeMessageApproval } from '../../safe/safeMessageApproval.js'
import { addressString, dataStringWith0xStart } from '../../utils/bigint.js'

export function SafeProposalDetails({ safeTx, messageReview }: { safeTx: SafeTx, messageReview: SafeMessageReview | undefined }) {
	if (safeTx.message.operation !== 1n) return <></>
	if (safeTx.message.to === SAFE_MULTI_SEND_CALL_ONLY) return <div class = 'textbox'>
		<p class = 'paragraph'>Atomic Safe batch: all calls execute in order as the Safe. If any call fails, the entire batch reverts.</p>
		{ decodeSafeBatch(safeTx.message.data).map((call, index) => <div key = { index }>
			<p class = 'paragraph'>{ index + 1 }. To: { addressString(call.to) }; value: { call.value.toString() } wei</p>
			<p class = 'paragraph' style = 'overflow-wrap: anywhere'>Calldata: { dataStringWith0xStart(call.data) }</p>
		</div>) }
	</div>
	if (messageReview === undefined || !matchesSafeMessageApproval(safeTx.message, messageReview)) return <></>
	return <div class = 'textbox'>
		<p class = 'paragraph'>On-chain Safe message approval. The message becomes approved only after this Safe transaction is executed.</p>
		<p class = 'paragraph' style = 'white-space: pre-wrap'>{ messageReview.text }</p>
	</div>
}
