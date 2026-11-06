import type { SigningProgress } from '../../signing/signingProgress.js'

export function SigningSteps({ steps, current, status = 'active' }: { steps: readonly string[], current: number, status?: SigningProgress['status'] }) {
	return <ol class = 'signing-steps' aria-label = { status === 'cancelled' ? 'Signing cancelled' : status === 'complete' ? 'Signing complete' : 'Signing progress' }>
		{ steps.map((step, index) => {
			const complete = status === 'complete' || status === 'active' && index < current
			return <li key = { step } aria-current = { status === 'active' && index === current ? 'step' : undefined } class = { complete ? 'is-complete' : '' }><span>{ complete ? '✓' : index + 1 }</span>{ step }</li>
		}) }
	</ol>
}
