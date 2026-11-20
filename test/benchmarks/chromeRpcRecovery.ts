import * as assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { RpcEntry } from '../../app/ts/types/rpc.js'
import { connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

async function waitForState(connection: CdpConnection, expression: string, description: string) {
	const deadline = Date.now() + 30_000
	while (!await connection.evaluate<boolean>(expression)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${ description }`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

const rpcServer = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch: async (request) => {
		const message: unknown = await request.json()
		const id = typeof message === 'object' && message !== null && 'id' in message ? message.id : 0
		return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Recovery fixture does not simulate chain data.' } })
	},
})

const network: RpcEntry = { name: 'Recovery RPC', chainId: 2n, httpsRpc: `http://127.0.0.1:${ rpcServer.port }`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const storedNetwork = RpcEntry.serialize(network)
const websiteAccess = [{ website: { websiteOrigin: 'recovery-block.test' }, declarativeNetRequestBlockMode: 'block-all' as const }]
const importedSettings = ExportedSettings.serialize({
	name: 'InterceptorSettingsAndAddressBook', version: '1.6', exportedDate: '2026-11-20',
	settings: {
		activeSimulationAddress: undefined, activeSigningSafeAddress: undefined, signingAddressPreferences: [], rpcNetwork: network,
		openedPage: { page: 'Home' }, useSignersAddressAsActiveAddress: false, websiteAccess, simulationMode: false,
		addressBookEntries: [], useTabsInsteadOfPopup: false, metamaskCompatibilityMode: false, safeAppsCompatibilityMode: true,
	},
})

try {
	for (const recovery of ['RPC selection', 'settings import'] as const) {
		const profileDir = await mkdtemp(path.join(os.tmpdir(), 'interceptor-rpc-recovery-'))
		try {
			// Persist the unavailable configuration in a real extension profile, then cold-start the actual background entry point.
			const initialChrome = await launchChromeSession(undefined, { profileDir })
			try {
				const target = await waitForInterceptorExtensionServiceWorker(initialChrome.browserDebugPort, 30_000)
				const worker = await connectTarget(initialChrome.browserDebugPort, target.id)
				try {
					await waitForPerformanceMarks(worker, ['interceptor:background:startup-ready'], 30_000)
					await worker.evaluate(`browser.storage.local.set(${ JSON.stringify({ activeRpcNetwork: 'corrupt', rpcEntries: [storedNetwork], websiteAccess, simulationMode: false }) })`)
					await worker.evaluate(`browser.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { initiatorDomains: ['recovery-block.test'], domainType: 'thirdParty' } }] })`)
				} finally { worker.close() }
			} finally { await initialChrome.close() }

			await rm(path.join(profileDir, 'DevToolsActivePort'), { force: true })
			const chrome = await launchChromeSession(undefined, { profileDir })
			try {
				const target = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
				const extensionId = new URL(target.url).hostname
				const worker = await connectTarget(chrome.browserDebugPort, target.id)
				try {
					await waitForPerformanceMarks(worker, ['interceptor:background:startup-ready'], 30_000)
					assert.equal(await worker.evaluate('(async()=> (await browser.storage.local.get("activeRpcNetwork")).activeRpcNetwork)()'), 'corrupt')
					assert.equal(await worker.evaluate('browser.action.getBadgeText({})'), '!')
					assert.equal(await worker.evaluate(`(async()=> (await browser.declarativeNetRequest.getDynamicRules()).some(rule => rule.condition.initiatorDomains?.includes('recovery-block.test')))()`), true)
					const pageId = await createTargetPage(chrome.browserConnection, `chrome-extension://${ extensionId }/html3/settingsViewV3.html`)
					const page = await connectTarget(chrome.browserDebugPort, pageId)
					try {
						await waitForState(page, 'typeof browser !== "undefined" && typeof browser.runtime?.sendMessage === "function"', 'settings runtime')
						await page.evaluate(`(() => { globalThis.__recoverySettingsReply = undefined; browser.runtime.onMessage.addListener((message) => { if (message.method === 'popup_requestSettingsReply') globalThis.__recoverySettingsReply = message.data }); void browser.runtime.sendMessage({ method: 'popup_requestSettings' }) })()`)
						await waitForState(page, 'globalThis.__recoverySettingsReply !== undefined', 'settings reply through startup gate')
						assert.equal(await page.evaluate('globalThis.__recoverySettingsReply.activeRpcNetwork'), undefined)
						const request = PopupMessage.serialize(recovery === 'RPC selection'
							? { method: 'popup_changeActiveRpc', data: network }
							: { method: 'popup_import_settings', data: { fileContents: JSON.stringify(importedSettings) } })
						await page.evaluate(`browser.runtime.sendMessage(${ JSON.stringify(request) })`)
						await waitForState(worker, `(async()=> { const { activeRpcNetwork } = await browser.storage.local.get('activeRpcNetwork'); return activeRpcNetwork?.httpsRpc === ${ JSON.stringify(network.httpsRpc) } })()`, 'repaired active network')
						const rules = await worker.evaluate<readonly { condition: { initiatorDomains?: readonly string[] } }[]>('browser.declarativeNetRequest.getDynamicRules()')
						assert.equal(rules.some((rule) => rule.condition.initiatorDomains?.includes('recovery-block.test')), true)
					} finally { page.close() }
				} finally { worker.close() }
			} finally { await chrome.close() }
			process.stdout.write(`Cold-start RPC recovery through ${ recovery } passed.\n`)
		} finally { await rm(profileDir, { recursive: true, force: true }) }
	}
} finally { rpcServer.stop(true) }
