export function SigningSteps({ steps, current }: { steps: readonly string[], current: number }) {
	return <ol class = 'signing-steps' aria-label = 'Signing progress'>
		{ steps.map((step, index) => <li key = { step } aria-current = { index === current ? 'step' : undefined } class = { index < current ? 'is-complete' : '' }><span>{ index < current ? '✓' : index + 1 }</span>{ step }</li>) }
	</ol>
}
