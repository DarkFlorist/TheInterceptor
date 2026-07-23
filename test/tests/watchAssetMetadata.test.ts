import { describe, expect, test } from 'bun:test'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { Erc1046ABI, Erc1155ABI, Erc20ABI, Erc721ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { loadErc1046Metadata, loadLegacyErc20Metadata, loadNftMetadataAndVerifyOwnership } from '../../app/ts/background/watchAssetMetadata.js'

const rpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.test',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

class SequentialCallHandler {
	public rpcUrl = rpcEntry.httpsRpc
	public constructor(private readonly replies: (string | Error)[]) {}
	public readonly jsonRpcRequest = async (request: EthereumJsonRpcRequest) => {
		if (request.method !== 'eth_call') throw new Error(`Unexpected RPC method ${ request.method }`)
		const reply = this.replies.shift()
		if (reply === undefined) throw new Error('Unexpected extra eth_call')
		if (reply instanceof Error) throw reply
		return reply
	}
	public readonly clearCache = () => undefined
	public readonly getChainId = async () => 1n
}

function createEthereum(replies: (string | Error)[]) {
	return new EthereumClientService(new SequentialCallHandler(replies), async () => undefined, async () => undefined, rpcEntry)
}

function metadataDataUri(value: unknown) {
	return `data:application/json,${ encodeURIComponent(JSON.stringify(value)) }`
}

describe('watch asset contract metadata', () => {
	test('loads an ERC1046 tokenURI and requires the interoperability marker', async () => {
		const validUri = metadataDataUri({ interop: { erc1046: true }, name: 'Metadata Token', symbol: 'META', decimals: 6, image: 'https://tokens.example/token.png' })
		const valid = await loadErc1046Metadata(createEthereum([encodeFunctionReturn(Erc1046ABI, 'tokenURI', [validUri])]), 1n)
		expect(valid).toEqual({ success: true, metadata: {
			metadataUri: validUri,
			name: 'Metadata Token',
			symbol: 'META',
			decimals: 6,
			description: undefined,
			imageUrl: 'https://tokens.example/token.png',
		} })

		const invalidUri = metadataDataUri({ name: 'No interoperability marker' })
		const invalid = await loadErc1046Metadata(createEthereum([encodeFunctionReturn(Erc1046ABI, 'tokenURI', [invalidUri])]), 1n)
		expect(invalid).toEqual({ success: false, code: -32602, message: 'The ERC1046 metadata was unavailable, malformed, or missing interop.erc1046.' })
	})

	test('does not expose unsafe metadata image destinations for download', async () => {
		for (const image of ['http://images.example/token.png', 'https://127.0.0.1/token.png', 'https://localhost/token.png', 'https://[::1]/token.png', 'https://images.example:8443/token.png']) {
			const metadataUri = metadataDataUri({ interop: { erc1046: true }, image })
			const result = await loadErc1046Metadata(createEthereum([encodeFunctionReturn(Erc1046ABI, 'tokenURI', [metadataUri])]), 1n)
			expect(result).toMatchObject({ success: true, metadata: { imageUrl: undefined } })
		}
	})

	test('rejects oversized data URIs before invoking their decoders', async () => {
		const originalAtob = globalThis.atob
		const originalDecodeURIComponent = globalThis.decodeURIComponent
		let atobCalls = 0
		let decodeCalls = 0
		globalThis.atob = () => { atobCalls++; throw new Error('Oversized base64 must not be decoded') }
		globalThis.decodeURIComponent = () => { decodeCalls++; throw new Error('Oversized percent data must not be decoded') }
		try {
			const base64Uri = `data:application/json;base64,${ 'A'.repeat(Math.ceil(262_144 / 3) * 4 + 1) }`
			const base64Result = await loadErc1046Metadata(createEthereum([encodeFunctionReturn(Erc1046ABI, 'tokenURI', [base64Uri])]), 1n)
			expect(base64Result.success).toBeFalse()

			const percentUri = `data:application/json,${ '%41'.repeat(262_145) }`
			const percentResult = await loadErc1046Metadata(createEthereum([encodeFunctionReturn(Erc1046ABI, 'tokenURI', [percentUri])]), 1n)
			expect(percentResult.success).toBeFalse()
			expect(atobCalls).toBe(0)
			expect(decodeCalls).toBe(0)
		} finally {
			globalThis.atob = originalAtob
			globalThis.decodeURIComponent = originalDecodeURIComponent
		}
	})

	test('verifies ERC721 ownership and loads token metadata', async () => {
		const owner = 0x2222222222222222222222222222222222222222n
		const metadataUri = metadataDataUri({ name: 'Collectible #42', description: 'A watched collectible', image: 'ipfs://example/image.png' })
		const result = await loadNftMetadataAndVerifyOwnership(createEthereum([
			encodeFunctionReturn(Erc721ABI, 'ownerOf', [`0x${ owner.toString(16) }`]),
			encodeFunctionReturn(Erc721ABI, 'tokenURI', [metadataUri]),
		]), 'ERC721', 1n, 42n, owner)

		expect(result).toEqual({ success: true, metadata: {
			metadataUri,
			name: 'Collectible #42',
			symbol: undefined,
			decimals: undefined,
			description: 'A watched collectible',
			imageUrl: 'https://ipfs.io/ipfs/example/image.png',
		} })
	})

	test('uses MetaMask-compatible errors for missing NFT ownership', async () => {
		const activeAddress = 0x2222222222222222222222222222222222222222n
		const otherOwner = 0x3333333333333333333333333333333333333333n
		const erc721 = await loadNftMetadataAndVerifyOwnership(createEthereum([
			encodeFunctionReturn(Erc721ABI, 'ownerOf', [`0x${ otherOwner.toString(16) }`]),
		]), 'ERC721', 1n, 42n, activeAddress)
		expect(erc721).toEqual({ success: false, code: -32000, message: 'The selected address does not own the requested ERC721 token.' })

		const erc1155 = await loadNftMetadataAndVerifyOwnership(createEthereum([
			encodeFunctionReturn(Erc1155ABI, 'balanceOf', [0n]),
		]), 'ERC1155', 1n, 42n, activeAddress)
		expect(erc1155).toEqual({ success: false, code: -32000, message: 'The selected address does not own the requested ERC1155 token.' })

		const noAddress = await loadNftMetadataAndVerifyOwnership(createEthereum([]), 'ERC721', 1n, 42n, undefined)
		expect(noAddress).toEqual({ success: false, code: -32002, message: 'Unable to verify NFT ownership because no active address is available.' })
	})

	test('propagates unexpected contract-call failures instead of reporting invalid metadata', async () => {
		const failure = new Error('RPC transport failed')
		const totalSupply = encodeFunctionReturn(Erc20ABI, 'totalSupply', [1n])
		const name = encodeFunctionReturn(Erc20ABI, 'name', ['Token'])
		const symbol = encodeFunctionReturn(Erc20ABI, 'symbol', ['TKN'])

		await expect(loadLegacyErc20Metadata(createEthereum([
			totalSupply,
			name,
			symbol,
			failure,
		]), 1n)).rejects.toBe(failure)
		await expect(loadErc1046Metadata(createEthereum([failure]), 1n)).rejects.toBe(failure)

		const activeAddress = 0x2222222222222222222222222222222222222222n
		await expect(loadNftMetadataAndVerifyOwnership(createEthereum([failure]), 'ERC721', 1n, 42n, activeAddress)).rejects.toBe(failure)
		await expect(loadNftMetadataAndVerifyOwnership(createEthereum([failure]), 'ERC1155', 1n, 42n, activeAddress)).rejects.toBe(failure)

		const owner = encodeFunctionReturn(Erc721ABI, 'ownerOf', [`0x${ activeAddress.toString(16) }`])
		await expect(loadNftMetadataAndVerifyOwnership(createEthereum([owner, failure]), 'ERC721', 1n, 42n, activeAddress)).rejects.toBe(failure)
		const balance = encodeFunctionReturn(Erc1155ABI, 'balanceOf', [1n])
		await expect(loadNftMetadataAndVerifyOwnership(createEthereum([balance, failure]), 'ERC1155', 1n, 42n, activeAddress)).rejects.toBe(failure)
	})
})
