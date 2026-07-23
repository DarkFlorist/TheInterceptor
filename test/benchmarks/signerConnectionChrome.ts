import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForAnyExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection } from './chromeHarness.js'

const extensionDir = globalThis.process.env.INTERCEPTOR_BENCH_EXTENSION_DIR
const warmupCount = 5
const sampleCount = 30

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitForSignerConnectionLatency(connection: CdpConnection, timeoutMs: number) {
	const start = Date.now()
	while (Date.now() - start <= timeoutMs) {
		const latency = await connection.evaluate<number | undefined>('globalThis.__interceptorSignerConnectionLatencyMs').catch(() => undefined)
		if (typeof latency === 'number') return latency
		await sleep(5)
	}
	throw new Error(`Timed out waiting for signer connection after ${ timeoutMs }ms`)
}

const fakeSignerPreload = `(() => {
	const startedAt = performance.now()
	const listeners = new Map()
	const signer = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }) => {
			if (method === 'eth_chainId') {
				globalThis.__interceptorSignerConnectionLatencyMs ??= performance.now() - startedAt
				return '0x1'
			}
			if (method === 'eth_accounts' || method === 'eth_requestAccounts') return []
			throw Object.assign(new Error('Unsupported benchmark signer method: ' + method), { code: -32601 })
		},
		on: (event, callback) => {
			listeners.set(event, [...listeners.get(event) ?? [], callback])
			return signer
		},
		removeListener: (event, callback) => {
			listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== callback))
			return signer
		},
	}
	globalThis.ethereum = signer
})()`

function percentile(sortedValues: readonly number[], percentileValue: number) {
	const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * percentileValue) - 1)
	const value = sortedValues[index]
	if (value === undefined) throw new Error('Cannot calculate a percentile without samples')
	return value
}

function summarize(samples: readonly number[]) {
	const sortedSamples = [...samples].sort((first, second) => first - second)
	const total = samples.reduce((sum, sample) => sum + sample, 0)
	return {
		samples: samples.length,
		meanMs: total / samples.length,
		medianMs: percentile(sortedSamples, 0.5),
		p95Ms: percentile(sortedSamples, 0.95),
		minMs: sortedSamples[0],
		maxMs: sortedSamples.at(-1),
	}
}

async function main() {
	const server = await startChromeCommunicationPageServer()
	const chrome = extensionDir === undefined ? await launchChromeSession() : await launchChromeSession(extensionDir)
	try {
		const workerTarget = await waitForAnyExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
		} finally {
			workerConnection.close()
		}

		const latencies: number[] = []
		for (let iteration = 0; iteration < warmupCount + sampleCount; iteration++) {
			const pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
			const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
			try {
				await pageConnection.send('Page.enable')
				await pageConnection.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSignerPreload })
				await pageConnection.send('Page.navigate', { url: `${ server.baseUrl }?signer-connection-benchmark=${ iteration }` })
				const latency = await waitForSignerConnectionLatency(pageConnection, 10_000)
				if (iteration >= warmupCount) latencies.push(latency)
			} finally {
				pageConnection.close()
				await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
			}
		}

		console.warn(JSON.stringify({
			extensionDir: extensionDir ?? 'app',
			warmupCount,
			...summarize(latencies),
		}, undefined, 2))
	} finally {
		await chrome.close().catch(() => undefined)
		await server.close().catch(() => undefined)
	}
}

await main()
