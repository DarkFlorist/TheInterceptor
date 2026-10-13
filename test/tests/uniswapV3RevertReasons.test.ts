import { describe, expect, test } from 'bun:test'
import { appendPossibleUniswapV3Explanation } from '../../app/ts/simulation/uniswapV3RevertReasons.js'

describe('Uniswap V3 revert reason explanations', () => {
	test('explains Uniswap V3 short error codes while keeping the original code visible', () => {
		expect(appendPossibleUniswapV3Explanation('STF')).toBe('STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		expect(appendPossibleUniswapV3Explanation('LOK')).toBe('LOK - possible Uniswap V3 error: The pool is locked, either because the call re-entered the pool or because the pool has not been initialized')
		expect(appendPossibleUniswapV3Explanation('SPL')).toBe('SPL - possible Uniswap V3 error: The swap price limit is on the wrong side of the current price or outside the supported range')
		expect(appendPossibleUniswapV3Explanation('T')).toBe('T - possible Uniswap V3 error: The tick is outside the minimum and maximum supported tick')
	})

	test('explains Uniswap V3 periphery revert strings', () => {
		expect(appendPossibleUniswapV3Explanation('Too little received')).toBe('Too little received - possible Uniswap V3 error: The swap output is below the minimum amount out, usually because the price moved beyond the slippage tolerance')
		expect(appendPossibleUniswapV3Explanation('Not cleared')).toBe('Not cleared - possible Uniswap V3 error: The position must have zero liquidity and no uncollected tokens before it can be burned')
	})

	test('only explains exact matches so unrelated revert reasons are unchanged', () => {
		expect(appendPossibleUniswapV3Explanation('Ownable: caller is not the owner')).toBe('Ownable: caller is not the owner')
		expect(appendPossibleUniswapV3Explanation('stf')).toBe('stf')
		expect(appendPossibleUniswapV3Explanation('STF ')).toBe('STF ')
		expect(appendPossibleUniswapV3Explanation('Error: STF')).toBe('Error: STF')
		expect(appendPossibleUniswapV3Explanation('Unknown error')).toBe('Unknown error')
	})

	test('leaves self-explanatory strings that unrelated contracts also use unattributed', () => {
		expect(appendPossibleUniswapV3Explanation('Transaction too old')).toBe('Transaction too old')
		expect(appendPossibleUniswapV3Explanation('Not approved')).toBe('Not approved')
		expect(appendPossibleUniswapV3Explanation('Invalid token ID')).toBe('Invalid token ID')
	})
})
