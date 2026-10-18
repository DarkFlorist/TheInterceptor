import type { DirectSigningRecord } from '../types/directSigning.js'

export type SigningProgress = Readonly<{ current: number, status: 'active' | 'complete' | 'cancelled' }>

/** Terminal states are explicit rather than sentinel indices outside the rendered steps. */
export function directSigningProgress(phase: DirectSigningRecord['phase'], isTransaction: boolean): SigningProgress {
	switch (phase) {
		case 'review': return { current: 0, status: 'active' }
		case 'approved': return { current: 1, status: 'active' }
		case 'signed': return { current: 2, status: isTransaction ? 'active' : 'complete' }
		case 'submitting': return { current: 2, status: 'active' }
		case 'submitted':
		case 'confirmed': return { current: 2, status: 'complete' }
		case 'cancelled': return { current: 0, status: 'cancelled' }
	}
}
