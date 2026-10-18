import { expect, test } from 'bun:test'
import { directSigningProgress } from '../../app/ts/signing/signingProgress.js'

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
