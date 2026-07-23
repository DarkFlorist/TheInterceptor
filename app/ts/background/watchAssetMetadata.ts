import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { Abi } from '../utils/ethereumPrimitives.js'
import { Erc1046ABI, Erc1155ABI, Erc20ABI, Erc721ABI } from '../utils/abi.js'
import { decodeFunctionOutputSafely, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, stringToUint8Array } from '../utils/bigint.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { fetchWithTimeout } from '../utils/requests.js'
import { isBigint, isNumberOrBigint, isString } from '../utils/typescript.js'

const MAX_ASSET_METADATA_BYTES = 262_144
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

const InteroperabilityMetadata = funtypes.ReadonlyObject({ erc1046: funtypes.Literal(true) })
const Erc1046Metadata = funtypes.ReadonlyObject({ interop: InteroperabilityMetadata }).And(funtypes.Partial({
	name: funtypes.String,
	symbol: funtypes.String,
	decimals: funtypes.Number,
	description: funtypes.String,
	image: funtypes.String,
	images: funtypes.ReadonlyArray(funtypes.String),
	icons: funtypes.ReadonlyArray(funtypes.String),
}))
const NftMetadata = funtypes.Partial({
	name: funtypes.String,
	description: funtypes.String,
	image: funtypes.String,
})

export type WatchAssetMetadata = {
	metadataUri: string
	name: string | undefined
	symbol: string | undefined
	decimals: number | undefined
	description: string | undefined
	imageUrl: string | undefined
}

export type WatchAssetMetadataResult =
	| { success: true, metadata: WatchAssetMetadata }
	| { success: false, code: -32602 | -32000 | -32002, message: string }

export type LegacyErc20MetadataResult =
	| { success: true, metadata: { name: string | undefined, symbol: string | undefined, decimals: bigint | undefined } }
	| { success: false, code: -32602, message: string }

function invalidMetadata(message: string): WatchAssetMetadataResult {
	return { success: false, code: -32602, message }
}

function isNonPublicIpv4(hostname: string) {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
	if (match === null) return false
	const octets = match.slice(1).map(Number)
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
	const [first, second, third] = octets
	if (first === undefined || second === undefined || third === undefined) return true
	return first === 0
		|| first === 10
		|| first === 100 && second !== undefined && second >= 64 && second <= 127
		|| first === 127
		|| first === 169 && second === 254
		|| first === 172 && second !== undefined && second >= 16 && second <= 31
		|| first === 192 && (second === 168 || second === 0 && (third === 0 || third === 2) || second === 88 && third === 99)
		|| first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)
		|| first === 203 && second === 0 && third === 113
		|| first >= 224
}

function safeRemoteUrl(uri: string): URL | undefined {
	const ipfsPath = uri.startsWith('ipfs://') ? uri.slice('ipfs://'.length).replace(/^ipfs\//, '') : undefined
	let url: URL
	try {
		url = new URL(ipfsPath === undefined ? uri : `${ IPFS_GATEWAY }${ ipfsPath }`)
	} catch {
		return undefined
	}
	const hostname = url.hostname.toLowerCase()
	if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return undefined
	if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.includes(':') || isNonPublicIpv4(hostname)) return undefined
	return url
}

function decodeDataJson(uri: string): string | undefined {
	const match = /^data:application\/json(?:;(?:charset=[^;,]+|utf8))?(;base64)?,(.*)$/i.exec(uri)
	if (match === null || match[2] === undefined) return undefined
	const payload = match[2]
	try {
		if (match[1] !== undefined) {
			if (payload.length > Math.ceil(MAX_ASSET_METADATA_BYTES / 3) * 4) return undefined
			if (!/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(payload)) return undefined
			const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
			if (payload.length / 4 * 3 - padding > MAX_ASSET_METADATA_BYTES) return undefined
			const binary = atob(payload)
			const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		}
		let decodedByteLength = 0
		for (let index = 0; index < payload.length; index++) {
			const character = payload[index]
			if (character === '%') {
				if (!/^[a-fA-F0-9]{2}$/.test(payload.slice(index + 1, index + 3))) return undefined
				decodedByteLength++
				index += 2
			} else {
				const codePoint = payload.codePointAt(index)
				if (codePoint === undefined) return undefined
				decodedByteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
				if (codePoint > 0xffff) index++
			}
			if (decodedByteLength > MAX_ASSET_METADATA_BYTES) return undefined
		}
		return decodeURIComponent(payload)
	} catch {
		return undefined
	}
}

async function fetchMetadataJson(uri: string): Promise<unknown | undefined> {
	const dataJson = decodeDataJson(uri)
	if (dataJson !== undefined) {
		try { return JSON.parse(dataJson) } catch { return undefined }
	}
	const url = safeRemoteUrl(uri)
	if (url === undefined) return undefined
	try {
		const response = await fetchWithTimeout(url, { redirect: 'error' }, 15_000)
		if (!response.ok) return undefined
		const contentLength = Number(response.headers.get('content-length'))
		if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_METADATA_BYTES) return undefined
		const reader = response.body?.getReader()
		if (reader === undefined) return undefined
		const chunks: Uint8Array[] = []
		let size = 0
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			if (value === undefined) continue
			size += value.byteLength
			if (size > MAX_ASSET_METADATA_BYTES) {
				await reader.cancel('metadata exceeded size limit')
				return undefined
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return JSON.parse(new TextDecoder().decode(bytes))
	} catch {
		return undefined
	}
}

async function callContract(ethereum: EthereumClientService, address: bigint, abi: Abi, functionName: string, args: readonly unknown[]) {
	const input = stringToUint8Array(encodeFunctionCall(abi, functionName, args))
	return await ethereum.call({ to: address, input }, 'latest', undefined)
}

async function getStringContractResult(ethereum: EthereumClientService, address: bigint, abi: Abi, functionName: string, args: readonly unknown[]) {
	const result = await callContract(ethereum, address, abi, functionName, args)
	return decodeFunctionOutputSafely(abi, functionName, result, isString)
}

async function getOptionalContractResult<T>(ethereum: EthereumClientService, address: bigint, abi: Abi, functionName: string, args: readonly unknown[], isExpectedType: (value: unknown) => value is T) {
	try {
		const result = await callContract(ethereum, address, abi, functionName, args)
		return decodeFunctionOutputSafely(abi, functionName, result, isExpectedType)
	} catch(error: unknown) {
		if (!(error instanceof JsonRpcResponseError)) throw error
		return undefined
	}
}

function normalizeErc1155Uri(uri: string, tokenId: bigint) {
	return uri.replaceAll('{id}', tokenId.toString(16).padStart(64, '0'))
}

export function normalizeWatchAssetImageUrl(uri: string | undefined) {
	if (uri === undefined) return undefined
	if (uri.startsWith('data:image/')) return uri.length <= MAX_ASSET_METADATA_BYTES * 2 ? uri : undefined
	return safeRemoteUrl(uri)?.toString()
}

export async function loadErc1046Metadata(ethereum: EthereumClientService, address: bigint): Promise<WatchAssetMetadataResult> {
	let metadataUri: string | undefined
	try {
		metadataUri = await getStringContractResult(ethereum, address, Erc1046ABI, 'tokenURI', [])
	} catch(error: unknown) {
		if (!(error instanceof JsonRpcResponseError)) throw error
		return invalidMetadata('The ERC1046 tokenURI() call failed.')
	}
	if (metadataUri === undefined) return invalidMetadata('The ERC1046 tokenURI() result was invalid.')
	const parsed = Erc1046Metadata.safeParse(await fetchMetadataJson(metadataUri))
	if (!parsed.success) return invalidMetadata('The ERC1046 metadata was unavailable, malformed, or missing interop.erc1046.')
	const metadata = parsed.value
	return { success: true, metadata: {
		metadataUri,
		name: metadata.name,
		symbol: metadata.symbol,
		decimals: metadata.decimals,
		description: metadata.description,
		imageUrl: normalizeWatchAssetImageUrl(metadata.icons?.[0] ?? metadata.image ?? metadata.images?.[0]),
	} }
}

export async function loadLegacyErc20Metadata(ethereum: EthereumClientService, address: bigint): Promise<LegacyErc20MetadataResult> {
	const [totalSupply, name, symbol, decimals] = await Promise.all([
		getOptionalContractResult(ethereum, address, Erc20ABI, 'totalSupply', [], isBigint),
		getOptionalContractResult(ethereum, address, Erc20ABI, 'name', [], isString),
		getOptionalContractResult(ethereum, address, Erc20ABI, 'symbol', [], isString),
		getOptionalContractResult(ethereum, address, Erc20ABI, 'decimals', [], isNumberOrBigint),
	])
	if (totalSupply === undefined) return { success: false, code: -32602, message: 'The requested address could not be verified as an ERC20 token contract.' }
	return { success: true, metadata: { name, symbol, decimals: decimals === undefined ? undefined : BigInt(decimals) } }
}

export async function loadNftMetadataAndVerifyOwnership(ethereum: EthereumClientService, type: 'ERC721' | 'ERC1155', address: bigint, tokenId: bigint, activeAddress: bigint | undefined): Promise<WatchAssetMetadataResult> {
	if (activeAddress === undefined) return { success: false, code: -32002, message: 'Unable to verify NFT ownership because no active address is available.' }
	try {
		if (type === 'ERC721') {
			const ownerResult = await callContract(ethereum, address, Erc721ABI, 'ownerOf', [tokenId])
			const ownerString = decodeFunctionOutputSafely(Erc721ABI, 'ownerOf', ownerResult, isString)
			const owner = ownerString === undefined ? undefined : BigInt(ownerString)
			if (owner === undefined) return { success: false, code: -32002, message: 'Unable to verify ERC721 ownership.' }
			if (owner !== activeAddress) return { success: false, code: -32000, message: 'The selected address does not own the requested ERC721 token.' }
		} else {
			const balanceResult = await callContract(ethereum, address, Erc1155ABI, 'balanceOf', [addressString(activeAddress), tokenId])
			const balance = decodeFunctionOutputSafely(Erc1155ABI, 'balanceOf', balanceResult, isBigint)
			if (balance === undefined) return { success: false, code: -32002, message: 'Unable to verify ERC1155 ownership.' }
			if (balance === 0n) return { success: false, code: -32000, message: 'The selected address does not own the requested ERC1155 token.' }
		}
	} catch(error: unknown) {
		if (!(error instanceof JsonRpcResponseError)) throw error
		return { success: false, code: -32002, message: `Unable to verify ${ type } ownership.` }
	}
	let metadataUri: string | undefined
	try {
		metadataUri = type === 'ERC721'
			? await getStringContractResult(ethereum, address, Erc721ABI, 'tokenURI', [tokenId])
			: await getStringContractResult(ethereum, address, Erc1155ABI, 'uri', [tokenId])
	} catch(error: unknown) {
		if (!(error instanceof JsonRpcResponseError)) throw error
		return invalidMetadata(`The ${ type } metadata URI call failed.`)
	}
	if (metadataUri === undefined) return invalidMetadata(`The ${ type } metadata URI result was invalid.`)
	const resolvedMetadataUri = type === 'ERC1155' ? normalizeErc1155Uri(metadataUri, tokenId) : metadataUri
	const parsed = NftMetadata.safeParse(await fetchMetadataJson(resolvedMetadataUri))
	if (!parsed.success) return invalidMetadata(`The ${ type } metadata was unavailable or malformed.`)
	return { success: true, metadata: {
		metadataUri: resolvedMetadataUri,
		name: parsed.value.name,
		symbol: undefined,
		decimals: undefined,
		description: parsed.value.description,
		imageUrl: normalizeWatchAssetImageUrl(parsed.value.image),
	} }
}
