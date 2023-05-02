import * as funtypes from 'funtypes'

export const QUARANTINE_CODES_DICT = {
	'ERC20_UNINTENDED_CONTRACT': {
		label: 'Attempt to send token to a contract that cannot receive such tokens',
		longExplanation: 'This transaction sends ERC20 tokens to a contract that cannot receive such tokens.',
	},
	'ERC20_ITSELF': {
		label: 'Attempt to send token to itself',
		longExplanation: 'This transaction sends ERC20 tokens to the token contract and will most likely result in a loss of the tokens you are attempting to send.',
	},
	'ERC20_DONTBELONG': {
		label: `Sending tokens to places where they don't belong to`,
		longExplanation: `This transaction sends ERC20 tokens to a contract that is not designed to receive ERC20 tokens directly.`
	},
	'ERC20_NOTAPPROVED': {
		label: 'Attempt to approve a non verified contract',
		longExplanation: `This transaction is approving an unverified contract to transfer your ERC20 tokens. Since the contract is unverified, it means that the contract's code is most likely not available for public review and the developer might be trying to hide something.`,
	},
	'BIG_FEE': {
		label: 'Attempt to send a transaction with an outrageous fee',
		longExplanation: 'This transaction has a very high fee. It is recommended that you send the transaction with a lower fee.',
	},
	'EOA_APPROVAL': {
		label: 'Attempt to approve Externally Owned Account',
		longExplanation: 'This transaction is approving a normal Ethereum address to spend your ERC20 tokens.',
	},
	'EOA_CALLDATA': {
		label: 'Transaction to an Externally Owned Account contains calldata',
		longExplanation: `This transaction is most likely a malformed transaction. The transaction contains data, which is used in calling contracts, but the recipient is not a contract.`
	},
	'FAILED_CHECK': {
		label: 'A check failed',
		longExplanation: `A check failed to complete. Most likely because the transaction stack is too big.`
	},
	'SIGNATURE_CHAIN_ID_DOES_NOT_MATCH': {
		label: 'Chain mismatch',
		longExplanation: `The signature request is for different chain than what is the active address.`
	},
	'SIGNATURE_ACCOUNT_DOES_NOT_MATCH': {
		label: 'Account and active address missmatch',
		longExplanation: `The signature request is for different account than what is your active address.`
	}
}

export const QUARANTINE_CODES = Object.values(QUARANTINE_CODES_DICT)

export type QUARANTINE_CODE = funtypes.Static<typeof QUARANTINE_CODE>
export const QUARANTINE_CODE = funtypes.Union(
	funtypes.Literal('ERC20_UNINTENDED_CONTRACT'),
	funtypes.Literal('ERC20_ITSELF'),
	funtypes.Literal('ERC20_DONTBELONG'),
	funtypes.Literal('ERC20_NOTAPPROVED'),
	funtypes.Literal('BIG_FEE'),
	funtypes.Literal('EOA_APPROVAL'),
	funtypes.Literal('EOA_CALLDATA'),
	funtypes.Literal('FAILED_CHECK'),
	funtypes.Literal('SIGNATURE_CHAIN_ID_DOES_NOT_MATCH'),
	funtypes.Literal('SIGNATURE_ACCOUNT_DOES_NOT_MATCH'),
)
