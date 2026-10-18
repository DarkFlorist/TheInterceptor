export const MAX_ERC20_DECIMALS = 255n

export function isValidErc20Decimals(decimals: bigint) {
	return decimals >= 0n && decimals <= MAX_ERC20_DECIMALS
}

// Tokens such as UNI and COMP store allowances as uint96, so their "max" approval is 2^96 - 1. Anything at or above it is shown as unlimited.
const UNLIMITED_ERC20_APPROVAL_THRESHOLD = 2n ** 96n - 1n

export function isUnlimitedErc20Approval(amount: bigint) {
	return amount >= UNLIMITED_ERC20_APPROVAL_THRESHOLD
}
