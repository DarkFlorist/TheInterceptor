import { describe, expect, test } from 'bun:test'
import { encodeErrorString, encodePanic } from './errorDataFixtures.js'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'
import { getFailureReasonForDisplay } from '../../app/ts/simulation/failureReasons.js'

const revertWithData = (data: string) => ({ code: 3, message: 'execution reverted', data })
const customStfErrorAbi = JSON.stringify([{ type: 'error', name: 'STF', inputs: [] }])
const customStfErrorSelector = '0x817275ab' // bytes4(keccak256('STF()'))

describe('getFailureReasonForDisplay', () => {
	test('keeps decodeEthereumError protocol-agnostic', () => {
		expect(decodeEthereumError([], revertWithData(encodeErrorString('STF'))).reason).toBe('STF')
	})

	test('appends protocol hints to exact Error(string) revert reasons', () => {
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('STF')))).toBe('STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('Ownable: caller is not the owner')))).toBe('Ownable: caller is not the owner')
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('')))).toBe('Unknown error')
	})

	test('does not apply protocol hints to other error kinds', () => {
		expect(getFailureReasonForDisplay([], revertWithData('0x'))).toBe('execution reverted')
		expect(getFailureReasonForDisplay([], revertWithData(encodePanic(0x11n)))).toBe('Arithmetic operation underflowed or overflowed outside of an unchecked block')
		expect(getFailureReasonForDisplay([customStfErrorAbi], revertWithData(customStfErrorSelector))).toBe('STF')
		expect(getFailureReasonForDisplay([], revertWithData(customStfErrorSelector))).toBe('execution reverted')
		expect(getFailureReasonForDisplay([], { code: -32000, message: 'STF' })).toBe('STF')
	})
})
