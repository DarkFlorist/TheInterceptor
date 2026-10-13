import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForCondition, waitForInterceptorExtensionServiceWorker, waitForPerformanceMarks, waitForRegisteredContentScripts, waitForTargetByUrl } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection } from './chromeHarness.js'
import { authorization as eip7702Authorization, Transaction } from 'micro-eth-signer'
import * as funtypes from 'funtypes'

const CommunicationPageState = funtypes.ReadonlyObject({
	phase: funtypes.Union(
		funtypes.Literal('loading'),
		funtypes.Literal('provider-ready'),
		funtypes.Literal('requesting-safe-only'),
		funtypes.Literal('safe-only-granted'),
		funtypes.Literal('requesting-access'),
		funtypes.Literal('access-granted'),
		funtypes.Literal('error'),
	),
	connectEvents: funtypes.Number,
	accountsChangedEvents: funtypes.Number,
	eventOrder: funtypes.ReadonlyArray(funtypes.String),
}).And(funtypes.ReadonlyPartial({
	accounts: funtypes.ReadonlyArray(funtypes.String),
	error: funtypes.String,
	errorCode: funtypes.Number,
}))
type CommunicationPageState = funtypes.Static<typeof CommunicationPageState>
const OptionalCommunicationPageState = funtypes.Union(funtypes.Undefined, CommunicationPageState)

const SafeAppsInfoResult = funtypes.ReadonlyObject({
	status: funtypes.Union(funtypes.Literal('fulfilled'), funtypes.Literal('pending'), funtypes.Literal('rejected')),
}).And(funtypes.ReadonlyPartial({
	data: funtypes.ReadonlyPartial({ safeAddress: funtypes.String, chainId: funtypes.Number }),
	error: funtypes.String,
	elapsedMs: funtypes.Number,
}))

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

function extractExtensionId(url: string) {
	const match = /^chrome-extension:\/\/([^/]+)/.exec(url)
	if (match?.[1] === undefined) throw new Error(`Could not determine extension id from ${ url }`)
	return match[1]
}

async function getCommunicationPageState(connection: CdpConnection): Promise<CommunicationPageState | undefined> {
	return OptionalCommunicationPageState.parse(await connection.evaluate(`(() => globalThis[${ JSON.stringify(COMMUNICATION_PAGE_STATE_GLOBAL) }] ?? undefined)()`))
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
		const enabled = await connection.evaluate(`(() => {
			const element = document.querySelector(${ JSON.stringify(selector) })
			return element instanceof HTMLButtonElement && element.disabled === false
		})()`).catch(() => false)
		return enabled === true
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

		pageTargetId = await createTargetPage(chrome.browserConnection, `${ server.baseUrl }?flow=wallet-request-permissions&safe-probe=early`)
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await waitForCommunicationPagePhase(pageConnection, 'requesting-access', 30_000)
			const preApprovalSafeProbeStatus = await pageConnection.evaluate('globalThis.__earlySafeAppsInfoResult?.status')
			if (preApprovalSafeProbeStatus !== 'pending') throw new Error(`Safe Apps advertised before website approval with status ${ typeof preApprovalSafeProbeStatus === 'string' ? preApprovalSafeProbeStatus : 'missing' }`)
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
			const safeAppsInfoResult = SafeAppsInfoResult.parse(await pageConnection.evaluate('globalThis.__safeAppsInfoResult'))
			if (safeAppsInfoResult.status !== 'pending') throw new Error(`Safe Apps advertised the approved EOA with status ${ safeAppsInfoResult.status }`)
			const earlySafeAppsInfoResult = SafeAppsInfoResult.parse(await pageConnection.evaluate('globalThis.__earlySafeAppsInfoResult'))
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
				await waitForCondition(async () => (await rawTransactionWorkerConnection.evaluate(`(async () => {
					const stored = await browser.storage.local.get('pendingTransactionsAndMessages')
					const serialized = JSON.stringify(stored.pendingTransactionsAndMessages ?? [])
					return serialized.includes('authorizationList') && (serialized.includes('"type":"0x4"') || serialized.includes('"type":"7702"'))
				})()`)) === true, 30_000, 'parsed EIP-7702 raw transaction in extension storage')
			} finally {
				rawTransactionWorkerConnection.close()
			}
			await closeTarget(chrome.browserConnection, confirmTarget.id)
			confirmTargetId = undefined
			await waitForCondition(async () => (await pageConnection.evaluate(`globalThis.__raw7702Result?.status === 'rejected'`)) === true, 10_000, 'raw EIP-7702 popup-close rejection')

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
