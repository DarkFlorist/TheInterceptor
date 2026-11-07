import { describe, expect, test } from 'bun:test'
import { appendProtocolRevertReasonHints, appendRevertReasonHints, type RevertReasonHintProvider } from '../../app/ts/simulation/revertReasonHints.js'

const createProvider = (protocolName: string, explanations: ReadonlyMap<string, string>): RevertReasonHintProvider => ({
	protocolName,
	explainRevertReason: (revertReason) => explanations.get(revertReason),
})
const exampleSwapProvider = createProvider('Example Swap', new Map([['XS', 'Example swap failed']]))
const exampleLendingProvider = createProvider('Example Lending', new Map([['XS', 'Example loan failed'], ['XL', 'Example liquidation failed']]))

describe('appendRevertReasonHints', () => {
	test('appends the explanation from the provider that recognises the revert reason', () => {
		expect(appendRevertReasonHints([exampleSwapProvider, exampleLendingProvider], 'XL')).toBe('XL - possible Example Lending error: Example liquidation failed')
	})

	test('lists every matching provider because the reverting contract is unknown', () => {
		expect(appendRevertReasonHints([exampleSwapProvider, exampleLendingProvider], 'XS')).toBe('XS - possible Example Swap error: Example swap failed; possible Example Lending error: Example loan failed')
	})

	test('keeps unrecognised revert reasons unchanged', () => {
		expect(appendRevertReasonHints([exampleSwapProvider, exampleLendingProvider], 'Ownable: caller is not the owner')).toBe('Ownable: caller is not the owner')
		expect(appendRevertReasonHints([], 'XS')).toBe('XS')
	})
})

describe('appendProtocolRevertReasonHints', () => {
	test('applies the registered Uniswap V3 provider', () => {
		expect(appendProtocolRevertReasonHints('STF')).toBe('STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		expect(appendProtocolRevertReasonHints('Ownable: caller is not the owner')).toBe('Ownable: caller is not the owner')
	})
})
