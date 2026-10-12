import { describe, expect, test } from 'bun:test'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'

const encodeErrorString = (message: string) => `0x08c379a0${ encodeAbiValues(['string'], [message]).slice(2) }`
const encodePanic = (code: bigint) => `0x4e487b71${ encodeAbiValues(['uint256'], [code]).slice(2) }`
const decodeRevertReason = (message: string) => decodeEthereumError([], { code: 3, message: 'execution reverted', data: encodeErrorString(message) }).reason

describe('decodeEthereumError Uniswap V3 revert reasons', () => {
	test('explains Uniswap V3 short error codes while keeping the original code visible', () => {
		expect(decodeRevertReason('STF')).toBe('STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		expect(decodeRevertReason('LOK')).toBe('LOK - possible Uniswap V3 error: The pool is locked, either because the call re-entered the pool or because the pool has not been initialized')
		expect(decodeRevertReason('SPL')).toBe('SPL - possible Uniswap V3 error: The swap price limit is on the wrong side of the current price or outside the supported range')
		expect(decodeRevertReason('T')).toBe('T - possible Uniswap V3 error: The tick is outside the minimum and maximum supported tick')
	})

	test('explains Uniswap V3 periphery revert strings', () => {
		expect(decodeRevertReason('Too little received')).toBe('Too little received - possible Uniswap V3 error: The swap output is below the minimum amount out, usually because the price moved beyond the slippage tolerance')
		expect(decodeRevertReason('Not cleared')).toBe('Not cleared - possible Uniswap V3 error: The position must have zero liquidity and no uncollected tokens before it can be burned')
	})

	test('only explains exact matches so unrelated revert reasons are unchanged', () => {
		expect(decodeRevertReason('Ownable: caller is not the owner')).toBe('Ownable: caller is not the owner')
		expect(decodeRevertReason('stf')).toBe('stf')
		expect(decodeRevertReason('STF ')).toBe('STF ')
		expect(decodeRevertReason('Error: STF')).toBe('Error: STF')
		expect(decodeRevertReason('')).toBe('Unknown error')
	})

	test('leaves self-explanatory strings that unrelated contracts also use unattributed', () => {
		expect(decodeRevertReason('Transaction too old')).toBe('Transaction too old')
		expect(decodeRevertReason('Not approved')).toBe('Not approved')
		expect(decodeRevertReason('Invalid token ID')).toBe('Invalid token ID')
	})

	test('does not apply Uniswap V3 explanations to other error kinds', () => {
		expect(decodeEthereumError([], { code: 3, message: 'execution reverted', data: '0x' }).reason).toBe('execution reverted')
		expect(decodeEthereumError([], { code: 3, message: 'execution reverted', data: encodePanic(0x11n) }).reason).toBe('Arithmetic operation underflowed or overflowed outside of an unchecked block')
		const customStfErrorAbi = JSON.stringify([{ type: 'error', name: 'STF', inputs: [] }])
		const customStfErrorSelector = '0x817275ab' // bytes4(keccak256('STF()'))
		expect(decodeEthereumError([customStfErrorAbi], { code: 3, message: 'execution reverted', data: customStfErrorSelector }).reason).toBe('STF')
		expect(decodeEthereumError([], { code: 3, message: 'execution reverted', data: customStfErrorSelector }).reason).toBe('execution reverted')
	})
})
