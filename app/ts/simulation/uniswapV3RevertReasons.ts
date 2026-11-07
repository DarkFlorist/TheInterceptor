import type { RevertReasonHintProvider } from './revertReasonHints.js'

// Source: https://docs.uniswap.org/contracts/v3/reference/error-codes plus the require strings in Uniswap/v3-core and Uniswap/v3-periphery.
// Self-explanatory periphery strings that unrelated contracts also use, such as 'Transaction too old', 'Not approved' and 'Invalid token ID', are deliberately not attributed to Uniswap.
const uniswapV3RevertReasonToExplanation = (revertReason: string): string | undefined => {
	switch (revertReason) {
		case 'LOK': return 'The pool is locked, either because the call re-entered the pool or because the pool has not been initialized'
		case 'TLU': return 'The lower tick must be below the upper tick'
		case 'TLM': return 'The lower tick must be greater than or equal to the minimum tick'
		case 'TUM': return 'The upper tick must be less than or equal to the maximum tick'
		case 'AI': return 'The pool is already initialized'
		case 'M0': return 'Mint failed because the pool did not receive the required amount of token0'
		case 'M1': return 'Mint failed because the pool did not receive the required amount of token1'
		case 'AS': return 'The swap amount cannot be zero'
		case 'SPL': return 'The swap price limit is on the wrong side of the current price or outside the supported range'
		case 'IIA': return 'Insufficient input amount: the pool did not receive enough input tokens during the swap callback'
		case 'L': return 'A flash loan requires the pool to have liquidity greater than zero'
		case 'F0': return 'The flash loan did not repay the borrowed token0 plus the fee'
		case 'F1': return 'The flash loan did not repay the borrowed token1 plus the fee'
		case 'LS': return 'Liquidity subtraction underflowed because more liquidity was removed than exists'
		case 'LA': return 'Liquidity addition overflowed'
		case 'OLD': return 'The requested oracle observation is older than the oldest stored observation'
		case 'I': return 'The pool has not been initialized'
		case 'NP': return 'Cannot burn from a position with zero liquidity'
		case 'LO': return 'The liquidity at this tick would exceed the maximum allowed liquidity per tick'
		case 'T': return 'The tick is outside the minimum and maximum supported tick'
		case 'R': return 'The square root price is outside the minimum and maximum supported price'
		case 'TF': return 'The pool failed to transfer tokens'
		case 'STF': return 'Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance'
		case 'ST': return 'Token transfer via safeTransfer failed'
		case 'SA': return 'Token approval via safeApprove failed'
		case 'STE': return 'Ether transfer via safeTransferETH failed'
		case 'Too little received': return 'The swap output is below the minimum amount out, usually because the price moved beyond the slippage tolerance'
		case 'Too much requested': return 'The swap input is above the maximum amount in, usually because the price moved beyond the slippage tolerance'
		case 'Price slippage check': return 'The token amounts added or removed are below the minimum amounts, usually because the price moved beyond the slippage tolerance'
		case 'Not cleared': return 'The position must have zero liquidity and no uncollected tokens before it can be burned'
		default: return undefined
	}
}

// Short codes such as 'T' or 'L' are still explained even though unrelated contracts can revert with them too. Pool reverts bubble up through routers, aggregators and V3 forks on many chains, and the simulation does not report which contract reverted, so the transaction's recipient cannot tell whether Uniswap V3 was involved. Only exact matches are explained, and appendRevertReasonHints labels the hint 'possible' next to the unchanged code.
export const uniswapV3RevertReasonHintProvider: RevertReasonHintProvider = {
	protocolName: 'Uniswap V3',
	explainRevertReason: uniswapV3RevertReasonToExplanation,
}
