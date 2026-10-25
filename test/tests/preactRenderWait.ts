import { act } from 'preact/test-utils'

const DEFAULT_RENDER_WAIT_TIMEOUT_MS = 5000

// Polls in separate act() calls because Preact flushes queued renders only when the outermost act() ends, so async renders such as lazy popup pages become visible between polls.
export async function waitForRenderedCondition(isRendered: () => boolean, description: string, timeoutMs = DEFAULT_RENDER_WAIT_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs
	while (!isRendered()) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${ timeoutMs } ms waiting for ${ description }`)
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
	}
}
