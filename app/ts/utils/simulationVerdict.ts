import type { AddressBookEntry } from '../types/addressBookTypes.js'

// How a simulated request turned out. A failure outranks a flag: a request that fails is never reported as merely flagged.
export type SimulationVerdict = 'succeeded' | 'flagged' | 'failed'

// Only the fields the verdict depends on, so every shape a transaction or signature takes in the UI can be passed in. Some of those shapes leave a field out, which counts as "not flagged" and "valid".
type TransactionOutcome = {
	readonly transactionStatus: 'Transaction Succeeded' | 'Transaction Failed' | 'Failed To Simulate'
	readonly quarantine?: boolean
}

type SignatureOutcome = {
	readonly isValidMessage?: boolean
	readonly quarantine?: boolean
}

// The verdict every view of a transaction starts from: the confirmation checks and buttons, the stack rows and their chips, and the summary icons. They decide here so they cannot disagree about the same transaction.
export function getTransactionVerdict(transaction: TransactionOutcome): SimulationVerdict {
	if (transaction.transactionStatus !== 'Transaction Succeeded') return 'failed'
	return transaction.quarantine === true ? 'flagged' : 'succeeded'
}

// The same verdict for a signature request, where an unreadable message counts as a failure.
export function getSignatureVerdict(signRequest: SignatureOutcome): SimulationVerdict {
	if (signRequest.isValidMessage === false) return 'failed'
	return signRequest.quarantine === true ? 'flagged' : 'succeeded'
}

// How much is known about an address, from the source of its address book entry.
export type AddressTrust = 'addressBook' | 'known' | 'selfReported' | 'unknown'

export function getAddressTrust(addressBookEntry: AddressBookEntry): AddressTrust {
	switch (addressBookEntry.entrySource) {
		case 'User': return 'addressBook'
		case 'DarkFloristMetadata':
		case 'Interceptor': return 'known'
		case 'OnChain': return 'selfReported'
		case 'FilledIn': return 'unknown'
	}
}
