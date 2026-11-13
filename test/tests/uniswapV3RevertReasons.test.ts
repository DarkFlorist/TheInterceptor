import { describe, expect, test } from 'bun:test'
import { uniswapV3RevertReasonHintProvider } from '../../app/ts/simulation/uniswapV3RevertReasons.js'

const explain = uniswapV3RevertReasonHintProvider.explainRevertReason

describe('Uniswap V3 revert reason hint provider', () => {
	test('labels its hints as Uniswap V3', () => {
		expect(uniswapV3RevertReasonHintProvider.protocolName).toBe('Uniswap V3')
	})

	test('explains Uniswap V3 short error codes', () => {
		expect(explain('STF')).toBe('Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		expect(explain('LOK')).toBe('The pool is locked, either because the call re-entered the pool or because the pool has not been initialized')
		expect(explain('SPL')).toBe('The swap price limit is on the wrong side of the current price or outside the supported range')
		expect(explain('T')).toBe('The tick is outside the minimum and maximum supported tick')
	})

	test('explains Uniswap V3 periphery revert strings', () => {
		expect(explain('Too little received')).toBe('The swap output is below the minimum amount out, usually because the price moved beyond the slippage tolerance')
		expect(explain('Not cleared')).toBe('The position must have zero liquidity and no uncollected tokens before it can be burned')
	})

	test('only explains exact matches so unrelated revert reasons get no hint', () => {
		expect(explain('Ownable: caller is not the owner')).toBeUndefined()
		expect(explain('stf')).toBeUndefined()
		expect(explain('STF ')).toBeUndefined()
		expect(explain('Error: STF')).toBeUndefined()
		expect(explain('Unknown error')).toBeUndefined()
	})

	test('leaves self-explanatory strings that unrelated contracts also use unattributed', () => {
		expect(explain('Transaction too old')).toBeUndefined()
		expect(explain('Not approved')).toBeUndefined()
		expect(explain('Invalid token ID')).toBeUndefined()
	})
})
