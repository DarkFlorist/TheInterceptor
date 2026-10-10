import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { launchFirefoxSession } from './firefoxHarness.js'

// Exercise the screenshot's handleInterceptedRequest -> refuseAccess -> reply serializer path in a real Firefox extension.
const extensionDirectory = process.env.RPC_REJECTION_EXTENSION_DIR ?? path.resolve('app')
const requestCount = Number(process.env.RPC_REJECTION_REQUEST_COUNT ?? 500)
if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > 100_000) throw new Error('RPC_REJECTION_REQUEST_COUNT must be an integer between 1 and 100000.')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Denied RPC request regression</title>', { headers: { 'content-type': 'text/html' } }) })
try {
	const session = await launchFirefoxSession(extensionDirectory)
	try {
		const settingsPage = await session.openExtensionPage('html/popup.html')
		try {
			await settingsPage.evaluate(`browser.storage.local.set({ websiteAccess: [{ website: { websiteOrigin: ${ JSON.stringify(server.url.host) } }, access: false }], simulationMode: true })`)
		} finally {
			await settingsPage.close()
		}
		const page = await session.openPage(server.url.href)
		try {
			await page.evaluate(`(async () => {
				const deadline = performance.now() + 15000;
				while (window.ethereum === undefined) {
					if (performance.now() > deadline) throw new Error('Injected provider did not become ready');
					await new Promise(resolve => setTimeout(resolve, 20));
				}
			})()`)
			for (let round = 0; round < 3; round += 1) {
				const encodedResult = await page.evaluate<string>(`(async () => {
					let rejected = 0;
					const started = performance.now();
					const workload = (async () => {
						for (let offset = 0; offset < ${ requestCount }; offset += 20) {
							await Promise.all(Array.from({ length: Math.min(20, ${ requestCount } - offset) }, async () => {
								try {
									await window.ethereum.request({ method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000001', 'latest'] });
								} catch (error) {
									if (error.code !== 4100) throw error;
									rejected += 1;
								}
							}));
						}
					})();
					let timeout;
					try {
						await Promise.race([workload, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Denied requests did not settle within 60 seconds')), 60000); })]);
						return JSON.stringify({ rejected, durationMs: performance.now() - started });
					} finally { clearTimeout(timeout); }
				})()`)
				assert.ok(encodedResult !== undefined)
				const result = JSON.parse(encodedResult)
				assert.equal(result.rejected, requestCount, 'Every denied request must settle with code 4100')
				process.stdout.write(`${ JSON.stringify({ browser: session.browserVersion, round: round + 1, requests: requestCount, ...result }) }\n`)
			}
		} finally {
			await page.close()
		}
	} finally {
		await session.close()
	}
} finally {
	await server.stop(true)
}
