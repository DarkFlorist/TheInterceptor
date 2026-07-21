import { describe, expect, test } from 'bun:test'
import { type EthereumJsonRpcRequest as EthereumJsonRpcRequestType, EthereumJsonRpcRequest, WalletWatchAsset } from '../../app/ts/types/JsonRpc-types.js'
import { enqueueStoredWatchAssetRequest, handleWatchAssetRequest, MAX_PENDING_WATCH_ASSET_REQUESTS, MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN, processWatchAssetQueue, replaceAddressBookEntryWithAsset, resolveWatchAsset, validateWatchAssetParameters } from '../../app/ts/background/windows/watchAsset.js'
import { parseEthereumJsonRpcRequestForBackground } from '../../app/ts/background/rpcRequestParsing.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { StoredWatchAssetRequest, type WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
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
		currentToken: {
			type: 'ERC20',
			name: `Current ${ requestId }`,
			symbol: `C${ requestId }`,
			decimals: 6n,
			address,
			chainId: 1n,
			entrySource: 'OnChain',
		},
		token: {
			type: 'ERC20',
			name: `Current ${ requestId }`,
			symbol: `C${ requestId }`,
			decimals: 6n,
			address,
			chainId: 1n,
			entrySource: 'User',
		},
		selectedImageUri: undefined,
		imageDownloadError: undefined,
		forwardToSigner: undefined,
	}
}

function createStoredNftRequest(requestId: number, tokenId: string): StoredWatchAssetRequest {
	const base = createStoredRequest(requestId)
	const currentToken = { type: 'ERC721' as const, name: 'Collection', symbol: 'NFT', address: base.token.address, chainId: 1n, entrySource: 'User' as const, watchedTokenIds: [] }
	return {
		...base,
		popupOrTabId: { type: 'popup', id: 200 + requestId },
		requestedAsset: { type: 'ERC721', options: { address: base.token.address, chainId: 1, tokenId } },
		currentToken,
		token: { ...currentToken, watchedTokenIds: [BigInt(tokenId)] },
	}
}

describe('wallet_watchAsset', () => {
	test('serializes persisted dialog state', () => {
		expect(() => StoredWatchAssetRequest.serialize(createStoredRequest(0))).not.toThrow()
		const serialized = StoredWatchAssetRequest.serialize({
			...createStoredRequest(0),
			forwardToSigner: { signerName: 'MetaMask', connectionName: 0n, ownerGeneration: 3, signerProviderGeneration: 1 },
		})
		expect(serialized.forwardToSigner?.connectionName).toBe('0x0')
	})

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

	test('requires tokenId for NFT asset types and rejects unsupported types at the RPC boundary', () => {
		for (const type of ['ERC721', 'ERC1155', 'ERC777']) {
			expect(() => WalletWatchAsset.parse({ method: 'wallet_watchAsset', params: [{ type, options: { address: tokenAddress } }] })).toThrow()
		}
	})

	test('routes malformed watch-asset parameters to the webpage as JSON-RPC invalid params', () => {
		const parsed = parseEthereumJsonRpcRequestForBackground({ ...interceptedRequest, params: [{ type: 'ERC721', options: { address: tokenAddress } }] })
		expect(parsed.success).toBeFalse()
		if (parsed.success) throw new Error('Expected malformed wallet_watchAsset request')
		expect(parsed.invalidRequestReply).toEqual({
			type: 'result',
			method: 'wallet_watchAsset',
			error: { code: -32602, message: 'Invalid wallet_watchAsset parameters.' },
		})
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

	test('rejects invalid decimal hints before identifying or storing token data', async () => {
		for (const decimals of [-1, 1.5, 37, Number.MAX_SAFE_INTEGER + 1]) {
			const requestWithInvalidDecimals = { ...interceptedRequest, params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: 1, decimals } }] }
			const parsed = WalletWatchAsset.parse(requestWithInvalidDecimals)
			let identifyCount = 0
			let updateCount = 0
			const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, requestWithInvalidDecimals, website, parsed, {
				identifyAddress: async (_ethereum, _abortController, address) => { identifyCount += 1; return { type: 'ERC20', address, name: 'Unexpected', symbol: 'NO', decimals: 18n } },
				getAddressBookEntries: async () => [],
				updateAddressBook: async () => { updateCount += 1 },
				scheduleDialog: () => { throw new Error('Invalid request must not schedule a dialog') },
			})

			expect(reply).toEqual({
				type: 'result',
				method: 'wallet_watchAsset',
				error: { code: -32602, message: 'The asset decimals must be an integer from 0 to 36.' },
			})
			expect(identifyCount).toBe(0)
			expect(updateCount).toBe(0)
		}
	})

	test('accepts ERC-20 decimal boundary hints', () => {
		for (const decimals of [0, 36]) {
			const parsed = WalletWatchAsset.parse({ ...interceptedRequest, params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: 1, decimals } }] })
			expect(validateWatchAssetParameters(parsed, 1n)).toBeUndefined()
		}
	})

	test('rejects malformed ERC20 hints before opening a dialog', () => {
		for (const options of [
			{ address: tokenAddress, symbol: '' },
			{ address: tokenAddress, symbol: 'TOO-LONG-SYMBOL' },
			{ address: tokenAddress, image: 'not a url' },
			{ address: tokenAddress, image: 'data:image/png;base64,AA==' },
		]) {
			const parsed = WalletWatchAsset.parse({ method: 'wallet_watchAsset', params: [{ type: 'ERC20', options }] })
			expect(validateWatchAssetParameters(parsed, 1n)).toBeString()
		}
	})

	test('accepts ERC721 and ERC1155 requests with decimal uint256 token IDs', () => {
		for (const type of ['ERC721', 'ERC1155'] as const) {
			const parsed = WalletWatchAsset.parse({ method: 'wallet_watchAsset', params: [{ type, options: { address: tokenAddress, tokenId: '42' } }] })
			expect(validateWatchAssetParameters(parsed, 1n)).toBeUndefined()
		}
	})

	test('rejects malformed NFT token IDs', () => {
		for (const tokenId of ['', '-1', '1.5', '0x1', ' 1', ((1n << 256n)).toString()]) {
			const parsed = WalletWatchAsset.parse({ method: 'wallet_watchAsset', params: [{ type: 'ERC721', options: { address: tokenAddress, tokenId } }] })
			expect(validateWatchAssetParameters(parsed, 1n)).toBeString()
		}
	})

	test('replaces a same-chain generic entry with verified token metadata', () => {
		const address = BigInt(tokenAddress)
		const token = { type: 'ERC20' as const, name: 'Verified Token', symbol: 'VER', decimals: 6n, address, chainId: 1n, entrySource: 'User' as const }
		const entries = replaceAddressBookEntryWithAsset([{
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

		expect(replaceAddressBookEntryWithAsset([stale, otherChain], verified)).toEqual([verified, otherChain])
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

		expect(replaceAddressBookEntryWithAsset([configuredContract, duplicate], verified)).toEqual([{
			...verified,
			logoUri: configuredContract.logoUri,
			abi: configuredContract.abi,
			useAsActiveAddress: true,
			askForAddressAccess: false,
			declarativeNetRequestBlockMode: 'block-all',
		}])
	})

	test('uses an explicitly downloaded token image instead of a previous address-book logo', () => {
		const address = BigInt(tokenAddress)
		const existing = { type: 'contract' as const, name: 'Existing', address, chainId: 1n, entrySource: 'User' as const, logoUri: 'data:image/png;base64,b2xk' }
		const token = { type: 'ERC20' as const, name: 'Verified', symbol: 'VER', decimals: 6n, address, chainId: 1n, entrySource: 'User' as const, logoUri: 'data:image/png;base64,bmV3' }

		expect(replaceAddressBookEntryWithAsset([existing], token)[0]?.logoUri).toBe(token.logoUri)
	})

	test('returns the EIP-747 recognition result before user interaction and compares with existing address-book data', async () => {
		const requestWithHints = { ...interceptedRequest, params: [{ type: 'ERC20', options: { address: tokenAddress, chainId: 1, symbol: 'NEW', decimals: 8 } }] }
		const parsed = WalletWatchAsset.parse(requestWithHints)
		let scheduledDialog: (() => void) | undefined
		const queuedRequests: StoredWatchAssetRequest[] = []
		const knownToken = { type: 'ERC20' as const, name: 'Known token', symbol: 'OLD', decimals: 18n, address: BigInt(tokenAddress), chainId: 1n, entrySource: 'User' as const }
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, requestWithHints, website, parsed, {
			identifyAddress: async () => { throw new Error('Existing token metadata must not be fetched from chain') },
			getAddressBookEntries: async () => [knownToken],
			enqueueRequest: async (request) => { queuedRequests.push(request) },
			scheduleDialog: (showDialog) => { scheduledDialog = showDialog },
		})

		expect(reply).toEqual({ type: 'result', method: 'wallet_watchAsset', result: true })
		expect(queuedRequests).toHaveLength(1)
		expect(queuedRequests[0]?.currentToken).toEqual(knownToken)
		expect(queuedRequests[0]?.token).toEqual({ ...knownToken, symbol: 'NEW', decimals: 8n })
		expect(scheduledDialog).toBeFunction()
	})

	test('identifies and stores missing token data before comparing the proposal', async () => {
		const parsed = WalletWatchAsset.parse(interceptedRequest)
		let addressBook: AddressBookEntries = [{ type: 'contract', address: BigInt(tokenAddress), name: 'Unidentified contract', entrySource: 'User', chainId: 1n, logoUri: 'data:image/png;base64,c2F2ZWQ=' }]
		let addressBookPublicationCount = 0
		const queuedRequests: StoredWatchAssetRequest[] = []
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({ type: 'ERC20', address, name: 'Identified', symbol: 'CHAIN', decimals: 18n }),
			getAddressBookEntries: async () => addressBook,
			updateAddressBook: async (update) => { addressBook = update(addressBook) },
			publishAddressBookChanged: async () => { addressBookPublicationCount += 1 },
			enqueueRequest: async (request) => { queuedRequests.push(request) },
			scheduleDialog: () => undefined,
		})

		const identifiedToken = { type: 'ERC20' as const, address: BigInt(tokenAddress), name: 'Identified', symbol: 'CHAIN', decimals: 18n, entrySource: 'OnChain' as const, chainId: 1n, logoUri: 'data:image/png;base64,c2F2ZWQ=' }
		expect(reply).toEqual({ type: 'result', method: 'wallet_watchAsset', result: true })
		expect(addressBook).toEqual([identifiedToken])
		expect(addressBookPublicationCount).toBe(1)
		expect(queuedRequests[0]?.currentToken).toEqual(identifiedToken)
		expect(queuedRequests[0]?.token).toEqual({ ...identifiedToken, entrySource: 'User' })
	})

	test('adds ERC721 and ERC1155 token IDs to verified address-book collections', async () => {
		for (const type of ['ERC721', 'ERC1155'] as const) {
			const rawRequest = { ...interceptedRequest, params: [{ type, options: { address: tokenAddress, chainId: 1, tokenId: '42' } }] }
			const parsed = WalletWatchAsset.parse(rawRequest)
			const collection = type === 'ERC721'
				? { type, address: BigInt(tokenAddress), name: 'Collectible', symbol: 'NFT', entrySource: 'User' as const, chainId: 1n, watchedTokenIds: [7n] }
				: { type, address: BigInt(tokenAddress), name: 'Items', symbol: 'ITEM', decimals: undefined, entrySource: 'User' as const, chainId: 1n, watchedTokenIds: [7n] }
			const queuedRequests: StoredWatchAssetRequest[] = []
			const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, rawRequest, website, parsed, {
				identifyAddress: async () => { throw new Error('Existing collection metadata must not be fetched from chain') },
				getAddressBookEntries: async () => [collection],
				enqueueRequest: async (request) => { queuedRequests.push(request) },
				scheduleDialog: () => undefined,
			})

			expect(reply).toEqual({ type: 'result', method: 'wallet_watchAsset', result: true })
			expect(queuedRequests[0]?.currentToken).toEqual(collection)
			expect(queuedRequests[0]?.token).toEqual({ ...collection, entrySource: 'User', watchedTokenIds: [7n, 42n] })
		}
	})

	test('identifies missing NFT collections and rejects a mismatched token standard', async () => {
		const rawRequest = { ...interceptedRequest, params: [{ type: 'ERC721' as const, options: { address: tokenAddress, tokenId: '1' } }] }
		const parsed = WalletWatchAsset.parse(rawRequest)
		let addressBook: AddressBookEntries = []
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, rawRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({ type: 'ERC1155', address, name: 'Wrong standard', symbol: 'WRONG', decimals: undefined, entrySource: 'OnChain' }),
			getAddressBookEntries: async () => addressBook,
			updateAddressBook: async (update) => { addressBook = update(addressBook) },
			scheduleDialog: () => { throw new Error('Mismatched request must not schedule a dialog') },
		})

		expect(reply).toEqual({
			type: 'result',
			method: 'wallet_watchAsset',
			error: { code: -32602, message: 'The requested address is not an ERC721 token contract on the active chain.' },
		})
		expect(addressBook).toEqual([])
	})

	test('rejects a directly probed non-ERC20 without scheduling a dialog', async () => {
		const parsed = WalletWatchAsset.parse(interceptedRequest)
		let scheduled = false
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({ type: 'contract', address }),
			getAddressBookEntries: async () => [],
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
			getAddressBookEntries: async () => [],
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
			downloadImage: async () => ({ data: undefined, failureReason: 'unused' }),
		})

		expect(requests).toEqual([])
		expect(addressBook).toEqual([stored.token])
		expect(addressBookPublicationCount).toBe(1)
		expect(closedPopupId).toBe(91)
		expect(processQueueCount).toBe(1)
	})

	test('merges sequential queued NFT approvals and refreshes the later proposal', async () => {
		const first = createStoredNftRequest(120, '1')
		const second = { ...createStoredNftRequest(120, '2'), request: { ...createStoredNftRequest(121, '2').request } }
		let requests: readonly StoredWatchAssetRequest[] = [first, second]
		let addressBook: AddressBookEntries = [first.currentToken]
		const dependencies = {
			getRequests: async () => requests,
			updateRequests: async (update: (stored: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) => { requests = update(requests); return requests },
			updateAddressBook: async (update: (entries: AddressBookEntries) => AddressBookEntries) => { addressBook = update(addressBook) },
			publishAddressBookChanged: async () => undefined,
			publish: async () => undefined,
			closeDialog: async () => undefined,
			processQueue: async () => undefined,
			sendToSigner: () => false,
			downloadImage: async () => ({ data: undefined, failureReason: 'unused' }),
		}

		await resolveWatchAsset(websiteTabConnections, { method: 'popup_watchAssetDialog', data: { action: 'add', uniqueRequestIdentifier: first.request.uniqueRequestIdentifier } }, dependencies)
		expect(requests[0]?.currentToken.type === 'ERC721' ? requests[0].currentToken.watchedTokenIds : undefined).toEqual([1n])
		expect(requests[0]?.token.type === 'ERC721' ? requests[0].token.watchedTokenIds : undefined).toEqual([1n, 2n])

		const refreshedSecond = requests[0]
		if (refreshedSecond === undefined) throw new Error('Expected refreshed second NFT request')
		await resolveWatchAsset(websiteTabConnections, { method: 'popup_watchAssetDialog', data: { action: 'add', uniqueRequestIdentifier: refreshedSecond.request.uniqueRequestIdentifier } }, dependencies)
		expect(addressBook[0]?.type === 'ERC721' ? addressBook[0].watchedTokenIds : undefined).toEqual([1n, 2n])
	})

	test('preserves a newer address-book logo when no downloaded replacement is selected', async () => {
		const base = createStoredRequest(110)
		const logoAtDialogOpen = 'data:image/png;base64,b2xk'
		const latestAddressBookLogo = 'data:image/png;base64,bmV3ZXI='
		const stored: StoredWatchAssetRequest = {
			...base,
			popupOrTabId: { type: 'popup', id: 110 },
			currentToken: { ...base.currentToken, logoUri: logoAtDialogOpen },
			token: { ...base.token, logoUri: logoAtDialogOpen },
			requestedAsset: { ...base.requestedAsset, options: { ...base.requestedAsset.options, image: 'https://assets.example/proposed.png' } },
		}
		let requests: readonly StoredWatchAssetRequest[] = [stored]
		let addressBook: AddressBookEntries = [{ ...stored.token, logoUri: latestAddressBookLogo }]

		await resolveWatchAsset(websiteTabConnections, { method: 'popup_watchAssetDialog', data: { action: 'add', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier } }, {
			getRequests: async () => requests,
			updateRequests: async (update) => { requests = update(requests); return requests },
			updateAddressBook: async (update) => { addressBook = update(addressBook) },
			publishAddressBookChanged: async () => undefined,
			publish: async () => undefined,
			closeDialog: async () => undefined,
			processQueue: async () => undefined,
			sendToSigner: () => false,
			downloadImage: async () => ({ data: undefined, failureReason: 'unused' }),
		})

		expect(addressBook[0]?.logoUri).toBe(latestAddressBookLogo)
	})

	test('disables wallet forwarding without dismissing the dialog when delivery is unavailable', async () => {
		const stored = {
			...createStoredRequest(12),
			popupOrTabId: { type: 'popup' as const, id: 92 },
			forwardToSigner: { signerName: 'MetaMask' as const, connectionName: 3n, ownerGeneration: 1, signerProviderGeneration: 1 },
		}
		let requests: readonly StoredWatchAssetRequest[] = [stored]
		let published: StoredWatchAssetRequest | undefined
		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'forward', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier },
		}, {
			getRequests: async () => requests,
			updateRequests: async (update) => { requests = update(requests); return requests },
			updateAddressBook: async () => undefined,
			publishAddressBookChanged: async () => undefined,
			publish: async (request) => { published = request },
			closeDialog: async () => { throw new Error('Dialog must remain open') },
			processQueue: async () => { throw new Error('Queue must not advance') },
			sendToSigner: () => false,
			downloadImage: async () => ({ data: undefined, failureReason: 'unused' }),
		})

		expect(requests).toHaveLength(1)
		expect(requests[0]?.forwardToSigner).toBeUndefined()
		expect(published?.forwardToSigner).toBeUndefined()
	})

	test('keeps website image URLs out of user-visible download errors', async () => {
		const imageUrl = 'not a valid URL containing private-value'
		const base = createStoredRequest(14)
		const stored: StoredWatchAssetRequest = {
			...base,
			popupOrTabId: { type: 'popup', id: 94 },
			requestedAsset: { ...base.requestedAsset, options: { ...base.requestedAsset.options, image: imageUrl } },
		}
		let requests: readonly StoredWatchAssetRequest[] = [stored]

		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'downloadImage', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier },
		}, {
			getRequests: async () => requests,
			updateRequests: async (update) => { requests = update(requests); return requests },
			updateAddressBook: async () => undefined,
			publishAddressBookChanged: async () => undefined,
			publish: async () => undefined,
			closeDialog: async () => undefined,
			processQueue: async () => undefined,
			sendToSigner: () => false,
			downloadImage: async () => ({ data: undefined, failureReason: `Failed to parse URL from ${ imageUrl }` }),
		})

		expect(requests[0]?.imageDownloadError).toBe('The proposed image could not be downloaded or decoded.')
		expect(requests[0]?.imageDownloadError).not.toContain(imageUrl)
	})

	test('downloads an opted-in image, keeps the dialog open, and stores it when the token is added', async () => {
		const base = createStoredRequest(13)
		const stored: StoredWatchAssetRequest = {
			...base,
			popupOrTabId: { type: 'popup', id: 93 },
			requestedAsset: { ...base.requestedAsset, options: { ...base.requestedAsset.options, image: 'https://assets.example/token.png' } },
		}
		let requests: readonly StoredWatchAssetRequest[] = [stored]
		let addressBook: AddressBookEntries = [{ ...stored.token, logoUri: 'data:image/png;base64,bGF0ZXN0' }]
		let publishCount = 0
		let closeCount = 0
		const dependencies = {
			getRequests: async () => requests,
			updateRequests: async (update: (storedRequests: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) => { requests = update(requests); return requests },
			updateAddressBook: async (update: (entries: AddressBookEntries) => AddressBookEntries) => { addressBook = update(addressBook) },
			publishAddressBookChanged: async () => undefined,
			publish: async () => { publishCount += 1 },
			closeDialog: async () => { closeCount += 1 },
			processQueue: async () => undefined,
			sendToSigner: () => false,
			downloadImage: async (url: string) => url === stored.requestedAsset.options.image
				? { data: 'data:image/png;base64,dG9rZW4=', failureReason: undefined }
				: { data: undefined, failureReason: 'unexpected URL' },
		}

		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'downloadImage', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier },
		}, dependencies)

		expect(requests[0]?.selectedImageUri).toBe('data:image/png;base64,dG9rZW4=')
		expect(publishCount).toBe(1)
		expect(closeCount).toBe(0)

		await resolveWatchAsset(websiteTabConnections, {
			method: 'popup_watchAssetDialog',
			data: { action: 'add', uniqueRequestIdentifier: stored.request.uniqueRequestIdentifier },
		}, dependencies)

		expect(addressBook[0]?.logoUri).toBe('data:image/png;base64,dG9rZW4=')
		expect(requests).toEqual([])
		expect(closeCount).toBe(1)
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
			downloadImage: async () => ({ data: undefined, failureReason: 'unused' }),
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
		expect(requests[0]?.forwardToSigner).toBeUndefined()
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

	test('canonicalizes NFT token IDs for queue deduplication while keeping distinct IDs', () => {
		const active = createStoredNftRequest(63, '1')
		const equivalent = { ...createStoredNftRequest(63, '01'), request: createStoredNftRequest(64, '01').request }
		const distinct = { ...createStoredNftRequest(63, '2'), request: createStoredNftRequest(65, '2').request }

		expect(enqueueStoredWatchAssetRequest([active], equivalent)).toEqual([active])
		expect(enqueueStoredWatchAssetRequest([active], distinct)).toEqual([active, distinct])
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
