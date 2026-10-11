import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { launchFirefoxSession } from './firefoxHarness.js'

// Exercise the screenshot's handleInterceptedRequest -> refuseAccess -> reply serializer path in a real Firefox extension.
const extensionDirectory = process.env.RPC_REJECTION_EXTENSION_DIR ?? path.resolve('app')
function integerOption(name: string, defaultValue: number, minimum: number, maximum: number) {
	const value = Number(process.env[name] ?? defaultValue)
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${ name } must be an integer between ${ minimum } and ${ maximum }.`)
	return value
}
const requestCount = integerOption('RPC_REJECTION_REQUEST_COUNT', 500, 1, 100_000)
const rounds = integerOption('RPC_REJECTION_ROUNDS', 3, 1, 1000)
const reloadEvery = integerOption('RPC_REJECTION_RELOAD_EVERY', 0, 0, 1000)
const idleMs = integerOption('RPC_REJECTION_IDLE_MS', 0, 0, 60_000)
const mixed = process.env.RPC_REJECTION_MIXED === 'true'
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
			const waitForProvider = async () => await page.evaluate(`(async () => {
				const deadline = performance.now() + 15000;
				while (window.ethereum === undefined) {
					if (performance.now() > deadline) throw new Error('Injected provider did not become ready');
					await new Promise(resolve => setTimeout(resolve, 20));
				}
			})()`)
			const idle = async (phase: string) => {
				if (idleMs === 0) return
				await page.evaluate(`(async () => {
					performance.mark('interceptor:rpc-load:idle-${ phase }-start');
					await new Promise(resolve => setTimeout(resolve, ${ idleMs }));
					performance.mark('interceptor:rpc-load:idle-${ phase }-end');
				})()`)
			}
			await waitForProvider()
			await idle('before')
			for (let round = 0; round < rounds; round += 1) {
				if (round > 0 && reloadEvery > 0 && round % reloadEvery === 0) {
					await page.reload()
					await waitForProvider()
				}

				const encodedResult = await page.evaluate<string>(`(async () => {
					let rejected = 0;
					let successful = 0;
					const started = performance.now();
					const workload = (async () => {
						for (let offset = 0; offset < ${ requestCount }; offset += 20) {
							await Promise.all(Array.from({ length: Math.min(20, ${ requestCount } - offset) }, async () => {
								const checkPublicRequests = async () => {
									if (!${ mixed }) return;
									const [accounts, chainId] = await Promise.all([
										window.ethereum.request({ method: 'eth_accounts' }),
										window.ethereum.request({ method: 'eth_chainId' }),
									]);
									if (!Array.isArray(accounts) || accounts.length !== 0 || chainId !== '0x1') throw new Error('Public RPC response changed for a denied website');
									successful += 2;
								};
								await checkPublicRequests();
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
						return JSON.stringify({ rejected, successful, durationMs: performance.now() - started });
					} finally { clearTimeout(timeout); }
				})()`)
				assert.ok(encodedResult !== undefined)
				const result = JSON.parse(encodedResult)
				assert.equal(result.rejected, requestCount, 'Every denied request must settle with code 4100')
				assert.equal(result.successful, mixed ? requestCount * 2 : 0, 'Every public request must settle successfully')
				process.stdout.write(`${ JSON.stringify({ browser: session.browserVersion, round: round + 1, requests: requestCount, ...result }) }\n`)
			}
			await idle('after')
		} finally {
			await page.close()
		}
	} finally {
		await session.close()
	}
} finally {
	await server.stop(true)
}
