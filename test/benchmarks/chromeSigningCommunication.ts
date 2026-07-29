import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForAnyExtensionServiceWorker, waitForPerformanceMarks, waitForPopupTarget, waitForRegisteredContentScripts, waitForTargetByUrl, waitForTargetGone } from './chromeHarness.js'
import { startChromeCommunicationPageServer } from './chromeCommunicationPageServer.js'
import type { CdpConnection } from './chromeHarness.js'

const ACCESS_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.is-primary:not(.is-danger)'
const CONFIRM_APPROVE_BUTTON_SELECTOR = 'nav.popup-button-row button.dialog-action-button.is-primary:not(.is-danger)'
const FAKE_SIGNER_ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const FAKE_SIGNED_TRANSACTION_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111'
const SELECTED_PROVIDER_UUID = '55555555-5555-4555-8555-555555555555'
const FAKE_PROVIDER_INFOS = await Promise.all([
	{ uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', rdns: 'io.metamask', iconFileName: 'metamask.svg' },
	{ uuid: SELECTED_PROVIDER_UUID, name: 'Rabby Wallet', rdns: 'io.rabby', iconFileName: 'rabby.svg' },
	{ uuid: '66666666-6666-4666-8666-666666666666', name: 'Brave Wallet', rdns: 'com.brave.wallet', iconFileName: 'brave.svg' },
].map(async ({ iconFileName, ...provider }) => ({
	...provider,
	icon: `data:image/svg+xml,${ encodeURIComponent(await Bun.file(`app/img/signers/${ iconFileName }`).text()) }`,
})))

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
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

async function waitForButtonEnabled(connection: CdpConnection, selector: string, timeoutMs: number) {
	await waitForCondition(async () => await connection.evaluate<boolean>(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		return element instanceof HTMLButtonElement && element.disabled === false
	})()`).catch(() => false), timeoutMs, `button ${ selector } to be enabled`)
}

async function clickButton(connection: CdpConnection, selector: string) {
	await connection.evaluate(`(() => {
		const element = document.querySelector(${ JSON.stringify(selector) })
		if (!(element instanceof HTMLButtonElement)) throw new Error('Could not find button ${ selector }')
		element.click()
	})()`)
}

async function pressKey(connection: CdpConnection, key: 'ArrowDown' | 'ArrowUp' | 'End' | 'Enter' | 'Escape' | 'Home') {
	const keyDetails = {
		ArrowDown: { code: 'ArrowDown', virtualKeyCode: 40 },
		ArrowUp: { code: 'ArrowUp', virtualKeyCode: 38 },
		End: { code: 'End', virtualKeyCode: 35 },
		Enter: { code: 'Enter', virtualKeyCode: 13 },
		Escape: { code: 'Escape', virtualKeyCode: 27 },
		Home: { code: 'Home', virtualKeyCode: 36 },
	}[key]
	await connection.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key,
		code: keyDetails.code,
		windowsVirtualKeyCode: keyDetails.virtualKeyCode,
		nativeVirtualKeyCode: keyDetails.virtualKeyCode,
	})
	await connection.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key,
		code: keyDetails.code,
		windowsVirtualKeyCode: keyDetails.virtualKeyCode,
		nativeVirtualKeyCode: keyDetails.virtualKeyCode,
	})
}

const fakeSignerPreload = `(() => {
	globalThis.__fakeSignerPreloadStarted = true
	const aggregateRequests = []
	const providerRequestsByUuid = {}
	const createSigner = (info) => {
		const requests = []
		const listeners = new Map()
		const signer = {
			selectedAddress: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) },
			isConnected: () => true,
			request: async ({ method }) => {
				requests.push(method)
				switch (method) {
					case 'eth_chainId': return '0x1'
					case 'eth_accounts':
					case 'eth_requestAccounts': return [${ JSON.stringify(FAKE_SIGNER_ADDRESS) }]
					case 'eth_sendTransaction': return ${ JSON.stringify(FAKE_SIGNED_TRANSACTION_HASH) }
					default: throw Object.assign(new Error('Unsupported fake signer method: ' + method), { code: -32601 })
				}
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
		providerRequestsByUuid[info.uuid] = requests
		return { info, provider: signer }
	}
	globalThis.__aggregateSignerRequests = aggregateRequests
	globalThis.__fakeSignerRequestsByUuid = providerRequestsByUuid
	globalThis.ethereum = {
		isBraveWallet: true,
		isConnected: () => true,
		request: async ({ method }) => {
			aggregateRequests.push(method)
			if (method === 'eth_chainId') return '0x1'
			if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [${ JSON.stringify(FAKE_SIGNER_ADDRESS) }]
			return await new Promise(() => undefined)
		},
		on: () => globalThis.ethereum,
		removeListener: () => globalThis.ethereum,
	}
	const providerInfos = ${ JSON.stringify(FAKE_PROVIDER_INFOS) }
	const providers = providerInfos.map(createSigner)
	globalThis.addEventListener('eip6963:requestProvider', () => {
		for (const detail of providers) {
			globalThis.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
		}
	})
})()`

async function main() {
	const server = await startChromeCommunicationPageServer()
	const chrome = await launchChromeSession()
	let pageTargetId: string | undefined
	let accessTargetId: string | undefined
	let confirmTargetId: string | undefined
	let selectionTargetId: string | undefined
	try {
		const workerTarget = await waitForAnyExtensionServiceWorker(chrome.browserDebugPort, 30_000)
		const extensionId = extractExtensionId(workerTarget.url)
		const workerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
		try {
			await waitForPerformanceMarks(workerConnection, ['interceptor:background:loaded'], 30_000)
			await waitForRegisteredContentScripts(workerConnection, ['inpage', 'inpage2'], 30_000)
			await workerConnection.evaluate('browser.storage.local.set({ simulationMode: false })')
		} finally {
			workerConnection.close()
		}

		pageTargetId = await createTargetPage(chrome.browserConnection, 'about:blank')
		const pageConnection = await connectTarget(chrome.browserDebugPort, pageTargetId)
		try {
			await pageConnection.send('Page.enable')
			await pageConnection.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSignerPreload })
			await pageConnection.send('Page.navigate', { url: server.baseUrl })
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'requesting-access'`).catch(() => false), 30_000, 'access request')

			const accessTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/interceptorAccessV3.html`, 30_000)
			accessTargetId = accessTarget.id
			const accessConnection = await connectTarget(chrome.browserDebugPort, accessTarget.id)
			try {
				await waitForButtonEnabled(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(accessConnection, ACCESS_APPROVE_BUTTON_SELECTOR)
			} finally {
				accessConnection.close()
			}
			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false), 30_000, 'access approval')
			} catch (error) {
				const accessState = await pageConnection.evaluate('({ state: globalThis.__interceptorChromeCommunicationState, preloadStarted: globalThis.__fakeSignerPreloadStarted, signerRequestsByUuid: globalThis.__fakeSignerRequestsByUuid, aggregateRequests: globalThis.__aggregateSignerRequests, ethereumType: typeof globalThis.ethereum, isBraveWallet: globalThis.ethereum?.isBraveWallet, isMetaMask: globalThis.ethereum?.isMetaMask })')
				throw new Error(`Access approval failed with page state ${ JSON.stringify(accessState) }`, { cause: error })
			}
			await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === accessTargetId, 10_000, 'completed initial access popup')
			accessTargetId = undefined
			const selectionWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
			let signerSelection: { readonly tabId: number, readonly websiteOrigin: string, readonly uuid: string }
			try {
				await waitForCondition(async () => await selectionWorkerConnection.evaluate<boolean>(`(async () => {
					const storage = await browser.storage.local.get()
					return Object.values(storage).some((value) => Array.isArray(value?.availableSignerProviders) && value.availableSignerProviders.length === ${ FAKE_PROVIDER_INFOS.length })
				})()`).catch(() => false), 10_000, 'EIP-6963 provider catalog')
				signerSelection = await selectionWorkerConnection.evaluate(`(async () => {
					const storage = await browser.storage.local.get()
					const tabState = Object.values(storage).find((value) => Array.isArray(value?.availableSignerProviders) && value.availableSignerProviders.length === ${ FAKE_PROVIDER_INFOS.length })
					if (tabState?.website === undefined) throw new Error('Missing website state for signer selection')
					const provider = tabState.availableSignerProviders.find((candidate) => candidate.rdns === 'io.rabby')
					if (provider === undefined) throw new Error('Missing Rabby provider for signer selection')
					return { tabId: tabState.tabId, websiteOrigin: tabState.website.websiteOrigin, uuid: provider.uuid }
				})()`)
				await selectionWorkerConnection.evaluate(`(async () => {
					const openPopup = browser.action.openPopup
					if (typeof openPopup !== 'function') throw new Error('browser.action.openPopup is unavailable')
					await openPopup()
				})()`, { userGesture: true })
			} finally {
				selectionWorkerConnection.close()
			}
			const selectionTarget = await waitForPopupTarget(chrome.browserDebugPort, extensionId, 30_000)
			selectionTargetId = selectionTarget.id
			const selectionConnection = await connectTarget(chrome.browserDebugPort, selectionTargetId)
			try {
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`(() => {
					const selector = document.querySelector('#signer-provider-selector')
					return selector instanceof HTMLButtonElement && selector.disabled === false
				})()`).catch(() => false), 30_000, 'rendered signer provider selector')
				await clickButton(selectionConnection, '#signer-provider-selector')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`(() => {
					const options = document.querySelector('#signer-provider-options')
					return options?.querySelectorAll('.signer-provider-option').length === ${ FAKE_PROVIDER_INFOS.length }
				})()`).catch(() => false), 10_000, 'rendered signer provider options')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(FAKE_PROVIDER_INFOS[0]?.uuid) }`).catch(() => false), 10_000, 'initial signer option focus')
				await pressKey(selectionConnection, 'End')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(FAKE_PROVIDER_INFOS.at(-1)?.uuid) }`).catch(() => false), 10_000, 'End signer option focus')
				await pressKey(selectionConnection, 'Home')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(FAKE_PROVIDER_INFOS[0]?.uuid) }`).catch(() => false), 10_000, 'Home signer option focus')
				await pressKey(selectionConnection, 'ArrowDown')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(signerSelection.uuid) }`).catch(() => false), 10_000, 'ArrowDown signer option focus')
				await pressKey(selectionConnection, 'Escape')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.id === 'signer-provider-selector' && document.querySelector('#signer-provider-options') === null`).catch(() => false), 10_000, 'Escape signer selector close')
				await pressKey(selectionConnection, 'ArrowUp')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(FAKE_PROVIDER_INFOS.at(-1)?.uuid) }`).catch(() => false), 10_000, 'ArrowUp signer selector reopen')
				await pressKey(selectionConnection, 'Home')
				await pressKey(selectionConnection, 'ArrowDown')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`document.activeElement?.getAttribute('data-provider-uuid') === ${ JSON.stringify(signerSelection.uuid) }`).catch(() => false), 10_000, 'keyboard signer selection focus')
				await pressKey(selectionConnection, 'Enter')
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__fakeSignerRequestsByUuid?.[${ JSON.stringify(SELECTED_PROVIDER_UUID) }]?.includes('eth_chainId')`).catch(() => false), 10_000, 'selected signer connection')
				await waitForCondition(async () => await selectionConnection.evaluate<boolean>(`(() => {
					const selector = document.querySelector('#signer-provider-selector')
					return selector instanceof HTMLButtonElement
						&& selector.getAttribute('aria-label')?.includes('Rabby Wallet') === true
						&& document.querySelector('#signer-provider-options') === null
				})()`).catch(() => false), 10_000, 'selected signer provider rendering')
			} finally {
				selectionConnection.close()
				await closeTarget(chrome.browserConnection, selectionTargetId)
				selectionTargetId = undefined
			}
			await pageConnection.evaluate(`(() => {
				const iframe = document.createElement('iframe')
				iframe.src = ${ JSON.stringify(`${ server.baseUrl }?signing-frame`) }
				globalThis.__signingFrame = iframe
				document.body.append(iframe)
			})()`)
			try {
				let iframeAccessTargetId: string | undefined
				await waitForCondition(async () => {
					if (await pageConnection.evaluate(`globalThis.__signingFrame?.contentWindow?.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false)) return true
					const targets = await chrome.browserConnection.send<{ targetInfos: readonly { targetId: string, url: string }[] }>('Target.getTargets')
					const accessTarget = targets.targetInfos.find((target) => target.url.startsWith(`chrome-extension://${ extensionId }/html3/interceptorAccessV3.html`))
					iframeAccessTargetId = accessTarget?.targetId
					return iframeAccessTargetId !== undefined
				}, 30_000, 'iframe access approval or address-access prompt')
				if (iframeAccessTargetId !== undefined) {
					accessTargetId = iframeAccessTargetId
					const iframeAccessConnection = await connectTarget(chrome.browserDebugPort, iframeAccessTargetId)
					try {
						await waitForButtonEnabled(iframeAccessConnection, ACCESS_APPROVE_BUTTON_SELECTOR, 30_000)
						await clickButton(iframeAccessConnection, ACCESS_APPROVE_BUTTON_SELECTOR)
					} finally {
						iframeAccessConnection.close()
					}
					await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingFrame?.contentWindow?.__interceptorChromeCommunicationState?.phase === 'access-granted'`).catch(() => false), 30_000, 'iframe address-access approval')
					await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === iframeAccessTargetId, 10_000, 'completed iframe access popup')
					accessTargetId = undefined
				}
			} catch(error: unknown) {
				const frameState = await pageConnection.evaluate('({ communicationState: globalThis.__signingFrame?.contentWindow?.__interceptorChromeCommunicationState, signerRequestsByUuid: globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid, aggregateRequests: globalThis.__signingFrame?.contentWindow?.__aggregateSignerRequests, topDocumentGeneration: globalThis[Symbol.for(\'dark.florist.interceptor.signerDocumentGeneration\')] })')
				const diagnosticWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
				const backgroundState = await diagnosticWorkerConnection.evaluate(`(async () => {
					const storage = await browser.storage.local.get()
					return { tabStates: Object.entries(storage).filter(([key]) => key.startsWith('tabState_')), websiteAccess: storage.websiteAccess, pendingAccessRequests: storage.pendingAccessRequests, interceptorErrorDiagnostics: storage.interceptorErrorDiagnostics }
				})()`).finally(() => diagnosticWorkerConnection.close())
				throw new Error(`Iframe access approval failed with frame state ${ JSON.stringify(frameState) } and background state ${ JSON.stringify(backgroundState) }`, { cause: error })
			}
			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid?.[${ JSON.stringify(SELECTED_PROVIDER_UUID) }]?.includes('eth_chainId')`).catch(() => false), 10_000, 'iframe selected signer propagation')
			} catch(error: unknown) {
				const frameState = await pageConnection.evaluate('({ signerRequestsByUuid: globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid, aggregateRequests: globalThis.__signingFrame?.contentWindow?.__aggregateSignerRequests, documentGeneration: globalThis.__signingFrame?.contentWindow?.[Symbol.for(\'dark.florist.interceptor.signerDocumentGeneration\')], topDocumentGeneration: globalThis[Symbol.for(\'dark.florist.interceptor.signerDocumentGeneration\')] })')
				const diagnosticWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
				const backgroundState = await diagnosticWorkerConnection.evaluate(`(async () => {
					const storage = await browser.storage.local.get()
					return { tabStates: Object.entries(storage).filter(([key]) => key.startsWith('tabState_')), interceptorErrorDiagnostics: storage.interceptorErrorDiagnostics }
				})()`).finally(() => diagnosticWorkerConnection.close())
				throw new Error(`Iframe signer propagation failed with frame state ${ JSON.stringify(frameState) } and background state ${ JSON.stringify(backgroundState) }`, { cause: error })
			}

			await pageConnection.evaluate(`(() => {
				globalThis.__signingResult = { status: 'pending' }
				globalThis.__signingFrame.contentWindow.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, to: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, value: '0x0', data: '0x' }] })
					.then((result) => { globalThis.__signingResult = { status: 'fulfilled', result } })
					.catch((error) => { globalThis.__signingResult = { status: 'rejected', error: error instanceof Error ? error.message : String(error), code: typeof error?.code === 'number' ? error.code : undefined } })
			})()`)

			const confirmTarget = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
			confirmTargetId = confirmTarget.id
			const confirmConnection = await connectTarget(chrome.browserDebugPort, confirmTarget.id)
			try {
				await waitForButtonEnabled(confirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR, 30_000)
				await clickButton(confirmConnection, CONFIRM_APPROVE_BUTTON_SELECTOR)
			} finally {
				confirmConnection.close()
			}

			try {
				await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid?.[${ JSON.stringify(SELECTED_PROVIDER_UUID) }]?.includes('eth_sendTransaction')`).catch(() => false), 10_000, 'iframe selected signer eth_sendTransaction request')
			} catch (error) {
				const signerState = await pageConnection.evaluate('({ signingResult: globalThis.__signingResult, signerRequestsByUuid: globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid, aggregateRequests: globalThis.__signingFrame?.contentWindow?.__aggregateSignerRequests })')
				const diagnosticWorkerConnection = await connectTarget(chrome.browserDebugPort, workerTarget.id)
				const backgroundState = await diagnosticWorkerConnection.evaluate(`(async () => {
					const storage = await browser.storage.local.get()
					return {
						tabStates: Object.entries(storage).filter(([key]) => key.startsWith('tabState_')),
						signerPreferences: storage.signerPreferences,
						interceptorErrorDiagnostics: storage.interceptorErrorDiagnostics,
					}
				})()`).finally(() => diagnosticWorkerConnection.close())
				throw new Error(`Signer request failed with page state ${ JSON.stringify(signerState) } and background state ${ JSON.stringify(backgroundState) }`, { cause: error })
			}
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingResult?.status === 'fulfilled'`).catch(() => false), 10_000, 'signing result')
			const signingResult = await pageConnection.evaluate<{ status?: string, result?: string }>('globalThis.__signingResult')
			if (signingResult.result !== FAKE_SIGNED_TRANSACTION_HASH) throw new Error(`Unexpected signing result: ${ signingResult.result ?? 'missing' }`)
			const aggregateReceivedSigningRequest = await pageConnection.evaluate<boolean>(`globalThis.__signingFrame?.contentWindow?.__aggregateSignerRequests?.includes('eth_sendTransaction')`)
			if (aggregateReceivedSigningRequest) throw new Error('Signing request was sent to Brave instead of the selected EIP-6963 provider')
			const nonSelectedProviderReceivedSigningRequest = await pageConnection.evaluate<boolean>(`Object.entries(globalThis.__signingFrame?.contentWindow?.__fakeSignerRequestsByUuid ?? {}).some(([uuid, requests]) => uuid !== ${ JSON.stringify(SELECTED_PROVIDER_UUID) } && requests.includes('eth_sendTransaction'))`)
			if (nonSelectedProviderReceivedSigningRequest) throw new Error('Signing request was sent to an EIP-6963 provider other than the selected provider')

			await waitForTargetGone(chrome.browserDebugPort, (target) => target.id === confirmTargetId, 10_000, 'completed confirmation popup')
			confirmTargetId = undefined
			await pageConnection.evaluate(`(() => {
				globalThis.__signingResult = { status: 'pending' }
				globalThis.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, to: ${ JSON.stringify(FAKE_SIGNER_ADDRESS) }, value: '0x0', data: '0x' }] })
					.then((result) => { globalThis.__signingResult = { status: 'fulfilled', result } })
					.catch((error) => { globalThis.__signingResult = { status: 'rejected', error: error instanceof Error ? error.message : String(error), code: typeof error?.code === 'number' ? error.code : undefined } })
			})()`)
			const confirmationToClose = await waitForTargetByUrl(chrome.browserDebugPort, `chrome-extension://${ extensionId }/html3/confirmTransactionV3.html`, 30_000)
			confirmTargetId = confirmationToClose.id
			await closeTarget(chrome.browserConnection, confirmationToClose.id)
			confirmTargetId = undefined
			await waitForCondition(async () => await pageConnection.evaluate(`globalThis.__signingResult?.status === 'rejected'`).catch(() => false), 10_000, 'closed-popup transaction rejection')
			const rejectedSigningResult = await pageConnection.evaluate<{ status?: string, code?: number }>('globalThis.__signingResult')
			if (rejectedSigningResult.code !== 4001) throw new Error(`Unexpected closed-popup rejection code: ${ rejectedSigningResult.code ?? 'missing' }`)
			console.warn('Interceptor Chrome signing communication test passed.')
		} finally {
			pageConnection.close()
		}
	} finally {
		if (selectionTargetId !== undefined) await closeTarget(chrome.browserConnection, selectionTargetId).catch(() => undefined)
		if (confirmTargetId !== undefined) await closeTarget(chrome.browserConnection, confirmTargetId).catch(() => undefined)
		if (accessTargetId !== undefined) await closeTarget(chrome.browserConnection, accessTargetId).catch(() => undefined)
		if (pageTargetId !== undefined) await closeTarget(chrome.browserConnection, pageTargetId).catch(() => undefined)
		await chrome.close().catch(() => undefined)
		await server.close().catch(() => undefined)
	}
}

await main()
