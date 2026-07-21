import { describe, expect, test } from 'bun:test'
import { type EthereumJsonRpcRequest as EthereumJsonRpcRequestType, EthereumJsonRpcRequest, WalletWatchAsset } from '../../app/ts/types/JsonRpc-types.js'
import { handleWatchAssetRequest, replaceAddressBookEntryWithVerifiedToken, validateWatchAssetParameters } from '../../app/ts/background/windows/watchAsset.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

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
		const reply = await handleWatchAssetRequest(ethereum, websiteTabConnections, interceptedRequest, website, parsed, {
			identifyAddress: async (_ethereum, _abortController, address) => ({
				type: 'ERC20', address, name: 'Verified', symbol: 'VER', decimals: 6n, entrySource: 'OnChain',
			}),
			scheduleDialog: (showDialog) => { scheduledDialog = showDialog },
		})

		expect(reply).toEqual({ type: 'result', method: 'wallet_watchAsset', result: true })
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
})
