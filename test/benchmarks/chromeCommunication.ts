import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getManifestV3ExcludeMatches } from '../../app/ts/utils/contentScriptsUpdating.js'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection, ChromeSession } from './chromeHarness.js'
import { authorization as eip7702Authorization, Transaction } from 'micro-eth-signer'

type CommunicationPageState = {
	phase: 'loading' | 'provider-ready' | 'requesting-access' | 'access-granted' | 'error'
	accounts?: readonly string[]
	error?: string
	errorCode?: number
	connectEvents: number
	accountsChangedEvents: number
	eventOrder: readonly string[]
}

type SafeAppsInfoResult = {
	status: 'fulfilled' | 'pending' | 'rejected'
	data?: { readonly safeAddress?: string, readonly chainId?: number }
	error?: string
	elapsedMs?: number
}

const COMMUNICATION_PAGE_STATE_GLOBAL = '__interceptorChromeCommunicationState' as const
const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const UNAVAILABLE_SIGNER_ERROR_MESSAGE = 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.'
const RAW_TRANSACTION_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001'
const AUTHORITY_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000002'

const clearDelegationAuthorization = eip7702Authorization.sign({
	chainId: 1n,
	address: '0x0000000000000000000000000000000000000000',
	nonce: 0n,
}, AUTHORITY_PRIVATE_KEY)
const signedEip7702Transaction = Transaction.prepare({
	type: 'eip7702',
	chainId: 1n,
	nonce: 0n,
	maxPriorityFeePerGas: 1n,
	maxFeePerGas: 2n,
	gasLimit: 100_000n,
	to: '0x0000000000000000000000000000000000000002',
	value: 0n,
	data: '0x',
	accessList: [],
	authorizationList: [clearDelegationAuthorization],
}, false).signBy(RAW_TRANSACTION_PRIVATE_KEY).toHex()

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

async function waitForCondition(condition: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
	const start = Date.now()
	while (true) {
		if (await condition()) return
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${ label } after ${ timeoutMs }ms`)
		await sleep(50)
	}
}

function extractExtensionId(url: string) {
	const match = /^chrome-extension:\/\/([^/]+)/.exec(url)
	if (match?.[1] === undefined) throw new Error(`Could not determine extension id from ${ url }`)
	return match[1]
}

async function getCommunicationPageState(connection: CdpConnection): Promise<CommunicationPageState | undefined> {
	return await connection.evaluate<CommunicationPageState | undefined>(`(() => globalThis[${ JSON.stringify(COMMUNICATION_PAGE_STATE_GLOBAL) }] ?? undefined)()`)
}

async function waitForCommunicationPagePhase(connection: CdpConnection, phase: CommunicationPageState['phase'], timeoutMs: number) {
	await waitForCondition(async () => {
		const state = await getCommunicationPageState(connection)
		if (state?.phase === 'error') throw new Error(`Communication page failed: ${ state.error ?? 'unknown error' }`)
		return state?.phase === phase
	}, timeoutMs, `communication page phase ${ phase }`)
}

async function waitForCommunicationPageError(connection: CdpConnection, timeoutMs: number) {
	await waitForCondition(async () => (await getCommunicationPageState(connection))?.phase === 'error', timeoutMs, 'communication page error')
	const state = await getCommunicationPageState(connection)
	if (state?.errorCode !== 4001) throw new Error(`Unexpected unavailable-signer error code: ${ state?.errorCode ?? 'missing' }`)
	if (state.error !== UNAVAILABLE_SIGNER_ERROR_MESSAGE) throw new Error(`Unexpected unavailable-signer error message: ${ state.error ?? 'missing' }`)
	return state
}

async function waitForButtonEnabled(connection: CdpConnection, selector: string, timeoutMs: number) {
	await waitForCondition(async () => {
		return Boolean(await connection.evaluate<boolean>(`(() => {
			const element = document.querySelector(${ JSON.stringify(selector) })
			return element instanceof HTMLButtonElement && element.disabled === false
		})()`).catch(() => false))
	}, timeoutMs, `button ${ selector } to be enabled`)
}

async function clickButton(connection: CdpConnection, selector: string) {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button ${ selector }')
		element.click()
		return true
	})()`)
}

async function verifyExactFileExclusions(chrome: ChromeSession, extensionId: string) {
	const fileDirectory = await mkdtemp(join(tmpdir(), 'interceptor-file-exclusions-'))
	const filePath = join(fileDirectory, 'dapp.html')
	const siblingPath = `${ filePath }.backup.html`
	const fileUrl = pathToFileURL(filePath).href
	const excludeMatches = getManifestV3ExcludeMatches([fileUrl])
	const workerTarget = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
	const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
	try {
		await Promise.all([writeFile(filePath, '<!doctype html><title>Disabled file</title>'), writeFile(siblingPath, '<!doctype html><title>Enabled sibling</title>')])
		const settingsTargetId = await createTargetPage(chrome.browserConnection, 'chrome://extensions/')
		try {
			const settingsConnection = await connectTarget(chrome.browserDebugPort, settingsTargetId)
			try {
				await settingsConnection.evaluate(`new Promise((resolve) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${ JSON.stringify(extensionId) }, fileAccess: true }, resolve))`)
			} finally {
				settingsConnection.close()
			}
		} finally {
			await closeTarget(chrome.browserConnection, settingsTargetId)
		}
		// Apply production patterns to the real registered provider scripts, then test Chromium's URL matching.
		await workerConnection.evaluate(`browser.scripting.updateContentScripts(['inpage', 'inpage2'].map((id) => ({ id, excludeMatches: ${ JSON.stringify(excludeMatches) } })))`)
		for (const [url, shouldInject] of [[fileUrl, false], [`${ fileUrl }?variant=1`, false], [pathToFileURL(siblingPath).href, true]] as const) {
			const targetId = await createTargetPage(chrome.browserConnection, url)
			try {
				const connection = await connectTarget(chrome.browserDebugPort, targetId)
				try {
					await waitForCondition(async () => await connection.evaluate<boolean>(`document.readyState === 'complete'`), 10_000, 'file document load')
					if (shouldInject) {
						await waitForCondition(async () => await connection.evaluate<boolean>('globalThis.ethereum?.isInterceptor === true'), 10_000, 'sibling file provider injection')
					} else if (await connection.evaluate<boolean>('globalThis.ethereum?.isInterceptor === true')) {
						throw new Error(`Interceptor injected into disabled file ${ url }`)
					}
				} finally {
					connection.close()
				}
			} finally {
				await closeTarget(chrome.browserConnection, targetId)
			}
		}
	} finally {
		try {
			await workerConnection.evaluate(`browser.scripting.updateContentScripts(['inpage', 'inpage2'].map((id) => ({ id, excludeMatches: [] })))`)
		} finally {
			workerConnection.close()
			await rm(fileDirectory, { recursive: true, force: true })
		}
	}
}

async function main() {
	const server = await startChromeCommunicationPageServer()
	const chrome = await launchChromeSession()
	let pageTargetId: string | undefined
	let accessTargetId: string | undefined
	let confirmTargetId: string | undefined
	try {
		const workerTarget = await waitForInterceptorExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionId = extractExtensionId(workerTarget.url)
		const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
			await workerConnection.evaluate('browser.storage.local.set({ safeAppsCompatibilityMode: true })')
		} finally {
			workerConnection.close()
		}

		await verifyExactFileExclusions(chrome, extensionId)

		pageTargetId = await createTargetPage(chrome.browserConnection, `${ server.baseUrl }?flow=wallet-request-permissions&safe-probe=early`)
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await waitForCommunicationPagePhase(pageConnection, 'requesting-access', 30_000)
			const preApprovalSafeProbeStatus = await pageConnection.evaluate<string | undefined>('globalThis.__earlySafeAppsInfoResult?.status')
			if (preApprovalSafeProbeStatus !== 'pending') throw new Error(`Safe Apps advertised before website approval with status ${ preApprovalSafeProbeStatus ?? 'missing' }`)
			const accessTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/interceptorAccessV3.html`, 30_000)
			accessTargetId = accessTarget.id
			const accessConnection = await connectTarget(chrome.browserDebugPort, accessTarget.id)
			try {
				await waitForButtonEnabled(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR)
			} finally {
				accessConnection.close()
			}

			await waitForCommunicationPagePhase(pageConnection, 'access-granted', 30_000)
			const accessGrantedState = await getCommunicationPageState(pageConnection)
			if (accessGrantedState?.connectEvents !== 0) throw new Error(`Account authorization emitted ${ accessGrantedState?.connectEvents ?? 'an unknown number of' } connect events`)
			if (accessGrantedState.accountsChangedEvents !== 1) throw new Error(`Account authorization emitted ${ accessGrantedState.accountsChangedEvents } accountsChanged events instead of one`)
			if (accessGrantedState.eventOrder.join(',') !== 'accountsChanged,permissionsResolved,accountsResolved') throw new Error(`Unexpected account authorization event order: ${ accessGrantedState.eventOrder.join(',') }`)

			await pageConnection.evaluate(`(() => {
				const id = crypto.randomUUID()
				const startedAt = performance.now()
				globalThis.__safeAppsInfoResult = { status: 'pending' }
				const listener = (event) => {
					if (event.source !== globalThis || event.data?.id !== id || typeof event.data?.success !== 'boolean') return
					globalThis.removeEventListener('message', listener)
					globalThis.__safeAppsInfoResult = event.data.success
						? { status: 'fulfilled', data: event.data.data, elapsedMs: performance.now() - startedAt }
						: { status: 'rejected', error: event.data.error, elapsedMs: performance.now() - startedAt }
				}
				globalThis.addEventListener('message', listener)
				globalThis.postMessage({ id, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, globalThis.location.origin)
			})()`)
			await sleep(250)
			const safeAppsInfoResult = await pageConnection.evaluate<SafeAppsInfoResult>('globalThis.__safeAppsInfoResult')
			if (safeAppsInfoResult.status !== 'pending') throw new Error(`Safe Apps advertised the approved EOA with status ${ safeAppsInfoResult.status }`)
			const earlySafeAppsInfoResult = await pageConnection.evaluate<SafeAppsInfoResult>('globalThis.__earlySafeAppsInfoResult')
			if (earlySafeAppsInfoResult.status !== 'pending') throw new Error(`Queued Safe Apps discovery advertised the approved EOA with status ${ earlySafeAppsInfoResult.status }`)

			await pageConnection.evaluate(`(() => {
				globalThis.__raw7702Result = { status: 'pending' }
				globalThis.ethereum.request({ method: 'eth_sendRawTransaction', params: [${ JSON.stringify(signedEip7702Transaction) }] })
					.then((result) => { globalThis.__raw7702Result = { status: 'fulfilled', result } })
					.catch((error) => { globalThis.__raw7702Result = { status: 'rejected', code: typeof error?.code === 'number' ? error.code : undefined } })
			})()`)
			const confirmTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
			confirmTargetId = confirmTarget.id
			const rawTransactionWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await waitForCondition(async () => await rawTransactionWorkerConnection.evaluate<boolean>(`(async () => {
					const stored = await browser.storage.local.get('pendingTransactionsAndMessages')
					const serialized = JSON.stringify(stored.pendingTransactionsAndMessages ?? [])
					return serialized.includes('authorizationList') && (serialized.includes('"type":"0x4"') || serialized.includes('"type":"7702"'))
				})()`), 30_000, 'parsed EIP-7702 raw transaction in extension storage')
			} finally {
				rawTransactionWorkerConnection.close()
			}
			await closeTarget(chrome.browserConnection, confirmTarget.id)
			confirmTargetId = undefined
			await waitForCondition(async () => await pageConnection.evaluate<boolean>(`globalThis.__raw7702Result?.status === 'rejected'`), 10_000, 'raw EIP-7702 popup-close rejection')

			const signingModeWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			try {
				await signingModeWorkerConnection.evaluate('browser.storage.local.set({ simulationMode: false, useSignersAddressAsActiveAddress: false })')
			} finally {
				signingModeWorkerConnection.close()
			}
			await pageConnection.send('Page.navigate', { url: `${ server.baseUrl }?signer=unavailable` })
			const unavailableSignerState = await waitForCommunicationPageError(pageConnection, 30_000)

			console.warn(`Interceptor Chrome communication smoke test passed for extension ${ extensionId }.`)
			console.warn(JSON.stringify({
				ok: true,
				extensionId,
				accessGrantedState,
				safeAppsInfoResult,
				earlySafeAppsInfoResult,
				unavailableSignerState,
			}, null, 2))
		} finally {
			pageConnection.close()
		}
	} finally {
		if (confirmTargetId !== undefined) await closeTarget(chrome.browserConnection, confirmTargetId).catch(() => undefined)
		if (accessTargetId !== undefined) await closeTarget(chrome.browserConnection, accessTargetId).catch(() => undefined)
		if (pageTargetId !== undefined) await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
		await chrome.close().catch(() => undefined)
		await server.close().catch(() => undefined)
	}
}

await main()
