import { evaluateBrowserTask } from './browserEvaluationTask.js'

export async function waitForBrowserCondition(condition: () => Promise<boolean | undefined>, label: string, timeoutMs = 30_000, options: { readonly retryNavigationErrors?: boolean } = {}) {
	const evaluateCondition = async () => {
		if (options.retryNavigationErrors === false) return await condition()
		const result = await evaluateBrowserTask(condition, { kind: 'navigation' })
		return result.kind === 'value' ? result.value : undefined
	}
	const deadline = Date.now() + timeoutMs
	while (true) {
		if (await evaluateCondition() === true) return
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${ label }`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}
