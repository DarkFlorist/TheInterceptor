import { describe, expect, test } from 'bun:test'
import { type EthereumJsonRpcRequest as EthereumJsonRpcRequestType, EthereumJsonRpcRequest, WalletWatchAsset } from '../../app/ts/types/JsonRpc-types.js'
import { enqueueStoredWatchAssetRequest, handleWatchAssetRequest, MAX_PENDING_WATCH_ASSET_REQUESTS, MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN, processWatchAssetQueue, replaceAddressBookEntryWithVerifiedToken, resolveWatchAsset, validateWatchAssetParameters } from '../../app/ts/background/windows/watchAsset.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { StoredWatchAssetRequest, WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'

const tokenAddress = '0x1111111111111111111111111111111111111111'
const rpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.test',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

class UnusedRequestHandler {
	public rpcUrl = rpcEntry.httpsRpc
	public readonly jsonRpcRequest = async (request: EthereumJsonRpcRequestType) => { throw new Error(`Unexpected RPC method ${ request.method }`) }
	public readonly clearCache = () => undefined
	public readonly getChainId = async () => 1n
}

const ethereum = new EthereumClientService(new UnusedRequestHandler(), async () => undefined, async () => undefined, rpcEntry)
const websiteTabConnections: WebsiteTabConnections = new Map()
const website = { websiteOrigin: 'https://dapp.example', title: 'Dapp', icon: undefined }
const interceptedRequest = {
	method: 'wallet_watchAsset',
	params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: 1 } }],
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 2, connectionName: 3n } },
}

function createStoredRequest(requestId: number, websiteOrigin = website.websiteOrigin): StoredWatchAssetRequest {
	const address = BigInt(tokenAddress) + BigInt(requestId)
	return {
		website: { ...website, websiteOrigin },
		popupOrTabId: undefined,
		request: {
			...interceptedRequest,
			uniqueRequestIdentifier: { ...interceptedRequest.uniqueRequestIdentifier, requestId },
		},
		requestedAsset: { ...WalletWatchAsset.parse(interceptedRequest).params[0], options: { address, chainId: 1 } },
		token: {
			type: 'ERC20',
			name: `Verified ${ requestId }`,
			symbol: `V${ requestId }`,
			decimals: 6n,
			address,
			chainId: 1n,
			entrySource: 'User',
		},
		canForward: false,
	}
}

describe('wallet_watchAsset', () => {
	test('is accepted as a supported ERC20 RPC request', () => {
		const parsed = EthereumJsonRpcRequest.parse({
			method: 'wallet_watchAsset',
			params: [{
				type: 'ERC20',
				options: { address: tokenAddress, chainId: 1, symbol: 'TEST', decimals: 18 },
			}],
		})

		expect(parsed.method).toBe('wallet_watchAsset')
		if (parsed.method !== 'wallet_watchAsset') throw new Error('Expected wallet_watchAsset request')
		expect(parsed.params[0].options.address).toBe(BigInt(tokenAddress))
		expect(validateWatchAssetParameters(parsed, 1n)).toBeUndefined()
	})

	test('rejects unsupported asset types', () => {
		const parsed = WalletWatchAsset.parse({
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC721', options: { address: tokenAddress } }],
		})

		expect(validateWatchAssetParameters(parsed, 1n)).toContain('Unsupported asset type')
	})

	test('requires an EIP-55 checksummed address', () => {
		expect(() => WalletWatchAsset.parse({
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC20', options: { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' } }],
		})).toThrow()
	})

	test('rejects requests for a different chain', () => {
		const parsed = WalletWatchAsset.parse({
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: 10 } }],
		})

		expect(validateWatchAssetParameters(parsed, 1n)).toBe('The asset chainId must match the active chain.')
	})

	test('rejects unsafe chain identifiers', () => {
		const parsed = WalletWatchAsset.parse({
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: Number.MAX_SAFE_INTEGER + 1 } }],
		})

		expect(validateWatchAssetParameters(parsed, 1n)).toBe('The asset chainId must be a non-negative safe integer.')
	})

	test('replaces a same-chain generic entry with verified token metadata', () => {
		const address = BigInt(tokenAddress)
		const token = { type: 'ERC20' as const, name: 'Verified Token', symbol: 'VER', decimals: 6n, address, chainId: 1n, entrySource: 'User' as const }
		const entries = replaceAddressBookEntryWithVerifiedToken([{
			type: 'contract',
			name: 'Previously unknown',
			address,
			chainId: 1n,
			entrySource: 'OnChain',
		}], token)

		expect(entries).toEqual([token])
	})

	test('replaces stale ERC20 metadata and preserves entries on other chains', () => {
		const address = BigInt(tokenAddress)
		const stale = { type: 'ERC20' as const, name: 'Stale', symbol: 'OLD', decimals: 18n, address, chainId: 1n, entrySource: 'User' as const }
		const otherChain = { ...stale, chainId: 10n }
		const verified = { ...stale, name: 'Verified', symbol: 'NEW', decimals: 6n }

		expect(replaceAddressBookEntryWithVerifiedToken([stale, otherChain], verified)).toEqual([verified, otherChain])
	})

	test('preserves user-managed fields and removes duplicate same-chain entries', () => {
		const address = BigInt(tokenAddress)
		const configuredContract = {
			type: 'contract' as const,
			name: 'Configured contract',
			address,
			chainId: 1n,
			entrySource: 'User' as const,
			logoUri: 'data:image/png;base64,AA==',
			abi: '[]',
			useAsActiveAddress: true,
			askForAddressAccess: false,
			declarativeNetRequestBlockMode: 'block-all' as const,
		}
		const duplicate = { ...configuredContract, name: 'Duplicate' }
		const verified = { type: 'ERC20' as const, name: 'Verified', symbol: 'VER', decimals: 6n, address, chainId: 1n, entrySource: 'User' as const }

		expect(replaceAddressBookEntryWithVerifiedToken([configuredContract, duplicate], verified)).toEqual([{
			...verified,
			logoUri: configuredContract.logoUri,
			abi: configuredContract.abi,
			useAsActiveAddress: true,
			askForAddressAccess: false,
			declarativeNetRequestBlockMode: 'block-all',
		}])
	})

	test('settles a valid request before scheduled dialog work starts', async () => {
		const parsed = WalletWatchAsset.parse(interceptedRequest)
		let scheduledDialog: (() => void) | undefined
		const queuedRequests: unknown[] = []
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({
				type: 'ERC20', address, name: 'Verified', symbol: 'VER', decimals: 6n, entrySource: 'OnChain',
			}),
			enqueueRequest: async (request) => { queuedRequests.push(request) },
			scheduleDialog: (showDialog) => { scheduledDialog = showDialog },
		})

		expect(reply).toEqual({ type: 'result', method: 'wallet_watchAsset', result: true })
		expect(queuedRequests).toHaveLength(1)
		expect(scheduledDialog).toBeFunction()
	})

	test('rejects a directly probed non-ERC20 without scheduling a dialog', async () => {
		const parsed = WalletWatchAsset.parse(interceptedRequest)
		let scheduled = false
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({ type: 'contract', address }),
			scheduleDialog: () => { scheduled = true },
		})

		expect(reply).toEqual({
			type: 'result',
			method: 'wallet_watchAsset',
			error: { code: -32602, message: 'The requested address is not an ERC20 token contract on the active chain.' },
		})
		expect(scheduled).toBeFalse()
	})

	test('propagates unexpected on-chain metadata failures', async () => {
		const parsed = WalletWatchAsset.parse(interceptedRequest)
		const failure = new Error('RPC transport failed')

		await expect(handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async () => { throw failure },
			scheduleDialog: () => { throw new Error('Dialog must not be scheduled') },
		})).rejects.toBe(failure)
	})

	test('resolves a persisted request without relying on in-memory dialog state', async () => {
		const stored = { ...createStoredRequest(11), popupOrTabId: { type: 'popup' as const, id: 91 } }
		let requests: readonly StoredWatchAssetRequest[] = [stored]
		let addressBook: AddressBookEntries = []
		let addressBookPublicationCount = 0
		let closedPopupId: number | undefined
		let processQueueCount = 0

		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'add', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier },
		}, {
			getRequests: async () => requests,
			updateRequests: async (update) => { requests = update(requests); return requests },
			updateAddressBook: async (update) => { addressBook = update(addressBook) },
			publishAddressBookChanged: async () => { addressBookPublicationCount += 1 },
			publish: async () => undefined,
			closeDialog: async (popupOrTabId) => { closedPopupId = popupOrTabId.id },
			processQueue: async () => { processQueueCount += 1 },
			sendToSigner: () => false,
		})

		expect(requests).toEqual([])
		expect(addressBook).toEqual([stored.token])
		expect(addressBookPublicationCount).toBe(1)
		expect(closedPopupId).toBe(91)
		expect(processQueueCount).toBe(1)
	})

	test('queues concurrent requests and opens the second dialog after the first settles', async () => {
		let requests: readonly StoredWatchAssetRequest[] = [createStoredRequest(21), createStoredRequest(22)]
		let nextPopupId = 100
		const publishedRequestIds: number[] = []
		const closedPopupIds: number[] = []
		const queueDependencies = {
			getRequests: async () => requests,
			updateRequests: async (update: (stored: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) => { requests = update(requests); return requests },
			openDialog: async () => ({ type: 'popup' as const, id: nextPopupId++ }),
			dialogExists: async () => true,
			closeDialog: async () => undefined,
			publish: async (request: StoredWatchAssetRequest) => { publishedRequestIds.push(request.request.uniqueRequestIdentifier.requestId) },
		}

		await processWatchAssetQueue(websiteTabConnections, queueDependencies)
		const first = requests[0]
		if (first === undefined) throw new Error('Expected first queued watch-asset request')
		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'reject', uniqueRequestIdentifier: first.request.uniqueRequestIdentifier },
		}, {
			getRequests: async () => requests,
			updateRequests: queueDependencies.updateRequests,
			updateAddressBook: async () => undefined,
			publishAddressBookChanged: async () => undefined,
			publish: queueDependencies.publish,
			closeDialog: async (popupOrTabId) => { closedPopupIds.push(popupOrTabId.id) },
			processQueue: async () => await processWatchAssetQueue(websiteTabConnections, queueDependencies),
			sendToSigner: () => false,
		})

		expect(publishedRequestIds).toEqual([21, 22])
		expect(closedPopupIds).toEqual([100])
		expect(requests).toHaveLength(1)
		expect(requests[0]?.request.uniqueRequestIdentifier.requestId).toBe(22)
		expect(requests[0]?.popupOrTabId).toEqual({ type: 'popup', id: 101 })
	})

	test('recovers an unassigned persisted request during worker startup', async () => {
		let requests: readonly StoredWatchAssetRequest[] = [createStoredRequest(31)]
		const publishedRequestIds: number[] = []
		await processWatchAssetQueue(undefined, {
			getRequests: async () => requests,
			updateRequests: async (update) => { requests = update(requests); return requests },
			openDialog: async () => ({ type: 'popup', id: 131 }),
			dialogExists: async () => false,
			closeDialog: async () => undefined,
			publish: async (request) => { publishedRequestIds.push(request.request.uniqueRequestIdentifier.requestId) },
		})

		expect(requests[0]?.popupOrTabId).toEqual({ type: 'popup', id: 131 })
		expect(requests[0]?.canForward).toBeFalse()
		expect(publishedRequestIds).toEqual([31])
	})

	test('does not lose a close wakeup while checking the active dialog', async () => {
		const first = { ...createStoredRequest(41), popupOrTabId: { type: 'popup' as const, id: 141 } }
		let requests: readonly StoredWatchAssetRequest[] = [first, createStoredRequest(42)]
		let reentrantProcessing: Promise<void> | undefined
		let closeInjected = false
		const publishedRequestIds: number[] = []
		const dependencies = {
			getRequests: async () => requests,
			updateRequests: async (update: (stored: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) => { requests = update(requests); return requests },
			openDialog: async () => ({ type: 'popup' as const, id: 142 }),
			dialogExists: async () => {
				if (!closeInjected) {
					closeInjected = true
					requests = requests.filter((request) => request.request.uniqueRequestIdentifier.requestId !== 41)
					reentrantProcessing = processWatchAssetQueue(undefined, dependencies)
				}
				return true
			},
			closeDialog: async () => undefined,
			publish: async (request: StoredWatchAssetRequest) => { publishedRequestIds.push(request.request.uniqueRequestIdentifier.requestId) },
		}

		await processWatchAssetQueue(undefined, dependencies)
		await reentrantProcessing

		expect(requests).toHaveLength(1)
		expect(requests[0]?.request.uniqueRequestIdentifier.requestId).toBe(42)
		expect(requests[0]?.popupOrTabId).toEqual({ type: 'popup', id: 142 })
		expect(publishedRequestIds.length).toBeGreaterThanOrEqual(1)
		expect(publishedRequestIds.every((requestId) => requestId === 42)).toBeTrue()
	})

	test('does not lose a close wakeup while creating the active dialog', async () => {
		let requests: readonly StoredWatchAssetRequest[] = [createStoredRequest(51), createStoredRequest(52)]
		let reentrantProcessing: Promise<void> | undefined
		let openCount = 0
		const closedPopupIds: number[] = []
		const publishedRequestIds: number[] = []
		const dependencies = {
			getRequests: async () => requests,
			updateRequests: async (update: (stored: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) => { requests = update(requests); return requests },
			openDialog: async () => {
				openCount += 1
				if (openCount === 1) {
					requests = requests.filter((request) => request.request.uniqueRequestIdentifier.requestId !== 51)
					reentrantProcessing = processWatchAssetQueue(undefined, dependencies)
				}
				return { type: 'popup' as const, id: 150 + openCount }
			},
			dialogExists: async () => true,
			closeDialog: async (popupOrTabId: { id: number }) => { closedPopupIds.push(popupOrTabId.id) },
			publish: async (request: StoredWatchAssetRequest) => { publishedRequestIds.push(request.request.uniqueRequestIdentifier.requestId) },
		}

		await processWatchAssetQueue(undefined, dependencies)
		await reentrantProcessing

		expect(closedPopupIds).toEqual([151])
		expect(requests).toHaveLength(1)
		expect(requests[0]?.request.uniqueRequestIdentifier.requestId).toBe(52)
		expect(requests[0]?.popupOrTabId).toEqual({ type: 'popup', id: 152 })
		expect(publishedRequestIds.every((requestId) => requestId === 52)).toBeTrue()
	})

	test('deduplicates repeated pending assets for the same origin, chain, type, and contract', () => {
		const active = { ...createStoredRequest(61), popupOrTabId: { type: 'popup' as const, id: 161 } }
		const duplicate = {
			...active,
			popupOrTabId: undefined,
			request: { ...active.request, uniqueRequestIdentifier: { ...active.request.uniqueRequestIdentifier, requestId: 62 } },
		}

		expect(enqueueStoredWatchAssetRequest([active], duplicate)).toEqual([active])
	})

	test('bounds each origin without evicting the active request', () => {
		const active = { ...createStoredRequest(70), popupOrTabId: { type: 'popup' as const, id: 170 } }
		let requests: readonly StoredWatchAssetRequest[] = [active]
		for (let index = 1; index <= MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN + 2; index += 1) {
			requests = enqueueStoredWatchAssetRequest(requests, createStoredRequest(70 + index))
		}

		expect(requests).toHaveLength(MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN)
		expect(requests[0]).toEqual(active)
	})

	test('bounds the global queue and does not let another origin evict the active request', () => {
		const active = { ...createStoredRequest(80, 'https://active.example'), popupOrTabId: { type: 'popup' as const, id: 180 } }
		let requests: readonly StoredWatchAssetRequest[] = [active]
		for (let index = 1; index < MAX_PENDING_WATCH_ASSET_REQUESTS; index += 1) {
			requests = enqueueStoredWatchAssetRequest(requests, createStoredRequest(80 + index, `https://dapp-${ index }.example`))
		}
		const overflow = createStoredRequest(180, 'https://overflow.example')
		requests = enqueueStoredWatchAssetRequest(requests, overflow)

		expect(requests).toHaveLength(MAX_PENDING_WATCH_ASSET_REQUESTS)
		expect(requests[0]).toEqual(active)
		expect(requests.some((request) => request.website.websiteOrigin === overflow.website.websiteOrigin)).toBeFalse()
	})
})
