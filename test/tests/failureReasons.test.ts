import { describe, expect, test } from 'bun:test'
import { encodeErrorString, encodePanic } from './errorDataFixtures.js'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'
import { getFailureReasonForDisplay } from '../../app/ts/simulation/failureReasons.js'

const revertWithData = (data: string) => ({ code: 3, message: 'execution reverted', data })
const customStfErrorAbi = JSON.stringify([{ type: 'error', name: 'STF', inputs: [] }])
const customStfErrorSelector = '0x817275ab' // bytes4(keccak256('STF()'))
const annotateRevertReason = (revertReason: string) => `${ revertReason } (annotated)`

describe('getFailureReasonForDisplay', () => {
	test('keeps decodeEthereumError protocol-agnostic', () => {
		expect(decodeEthereumError([], revertWithData(encodeErrorString('STF'))).reason).toBe('STF')
	})

	test('applies only the caller annotation to decoded Error(string) revert reasons', () => {
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('STF')), (revertReason) => revertReason)).toBe('STF')
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('STF')), annotateRevertReason)).toBe('STF (annotated)')
		expect(getFailureReasonForDisplay([], revertWithData(encodeErrorString('')), annotateRevertReason)).toBe('Unknown error (annotated)')
	})

	test('does not annotate other error kinds', () => {
		expect(getFailureReasonForDisplay([], revertWithData('0x'), annotateRevertReason)).toBe('execution reverted')
		expect(getFailureReasonForDisplay([], revertWithData(encodePanic(0x11n)), annotateRevertReason)).toBe('Arithmetic operation underflowed or overflowed outside of an unchecked block')
		expect(getFailureReasonForDisplay([customStfErrorAbi], revertWithData(customStfErrorSelector), annotateRevertReason)).toBe('STF')
		expect(getFailureReasonForDisplay([], revertWithData(customStfErrorSelector), annotateRevertReason)).toBe('execution reverted')
		expect(getFailureReasonForDisplay([], { code: -32000, message: 'STF' }, annotateRevertReason)).toBe('STF')
	})
})
