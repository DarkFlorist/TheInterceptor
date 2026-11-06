import { expect, test } from 'bun:test'
import { directSigningProgress, getDirectSigningCompletion } from '../../app/ts/signing/signingProgress.js'

test('terminal signing phases use explicit completion or cancellation within the three visible steps', () => {
	for (const isTransaction of [true, false]) {
		for (const phase of ['review', 'approved', 'signed', 'submitting', 'submitted', 'confirmed', 'cancelled'] as const) {
			const progress = directSigningProgress(phase, isTransaction)
			expect(progress.current).toBeGreaterThanOrEqual(0)
			expect(progress.current).toBeLessThan(3)
		}
	}
	expect(directSigningProgress('signed', false)).toEqual({ current: 2, status: 'complete' })
	expect(directSigningProgress('signed', true)).toEqual({ current: 2, status: 'active' })
	expect(directSigningProgress('submitting', true).status).toBe('active')
	expect(directSigningProgress('submitted', true).status).toBe('complete')
	expect(directSigningProgress('confirmed', true).status).toBe('complete')
	expect(directSigningProgress('cancelled', true).status).toBe('cancelled')
})

test('a refused signature keeps the return step active instead of reporting completion', () => {
	expect(directSigningProgress('signed', false, true)).toEqual({ current: 2, status: 'active' })
	expect(directSigningProgress('submitted', true, true)).toEqual({ current: 2, status: 'active' })
	expect(directSigningProgress('confirmed', true, true)).toEqual({ current: 2, status: 'active' })
})

test('the signing page reports a signature as returned only when Interceptor did not refuse it', () => {
	const message = { input: { method: 'personal_sign' as const, data: '0x01', address: '0x0000000000000000000000000000000000000001', chainId: 1n }, executionSucceeded: undefined }
	const transaction = { ...message, input: { ...message.input, method: 'eth_sendTransaction' as const } }
	expect(getDirectSigningCompletion({ ...message, phase: 'signed' }, undefined)).toEqual({ complete: true, title: 'Message signature verified', refusal: undefined })
	const refusedMessage = getDirectSigningCompletion({ ...message, phase: 'signed' }, 'The Gnosis Safe nonce changed from 0 to 1 after this confirmation opened.')
	expect(refusedMessage.complete).toBe(false)
	expect(refusedMessage.title).toBe('Signature not returned to application')
	expect(refusedMessage.refusal).toMatchObject({ reason: 'The Gnosis Safe nonce changed from 0 to 1 after this confirmation opened.', canCancel: true })
	const refusedTransaction = getDirectSigningCompletion({ ...transaction, phase: 'submitted' }, 'Refused')
	expect(refusedTransaction.complete).toBe(false)
	expect(refusedTransaction.refusal).toMatchObject({ reason: 'Refused', canCancel: false })
	// A signed transaction that is not broadcast yet has not been offered to the website, so no refusal applies to it.
	expect(getDirectSigningCompletion({ ...transaction, phase: 'signed' }, 'Refused')).toEqual({ complete: false, title: 'Ready to broadcast', refusal: undefined })
	expect(getDirectSigningCompletion({ ...transaction, phase: 'confirmed', executionSucceeded: true }, undefined)).toEqual({ complete: true, title: 'Transaction confirmed', refusal: undefined })
})
