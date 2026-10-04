export const MAX_ERC20_DECIMALS = 255n

export function isValidErc20Decimals(decimals: bigint) {
	return decimals >= 0n && decimals <= MAX_ERC20_DECIMALS
}
