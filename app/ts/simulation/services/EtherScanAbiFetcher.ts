import { EtherscanGetABIResult, EtherscanSourceCodeResult, SourcifyMetadataResult } from '../../types/etherscan.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'
import { getDefaultBlockExplorer } from '../../background/settings.js'
import type { ChainIdWithUniversal } from '../../types/addressBookTypes.js'
import type { BlockExplorer, RpcEntries } from '../../types/rpc.js'
import { getRpcList } from '../../background/storageVariables.js'
import type { Result } from 'funtypes'
import { isValidAbiString } from '../../utils/abiRuntime.js'
import { fetchWithTimeout } from '../../utils/requests.js'
import { reportLocalRecovery } from '../../utils/errors.js'

const BLOCK_EXPLORER_FETCH_TIMEOUT_MS = 15_000

async function fetchJson(url: string): Promise<{ success: true, result: unknown } | { success: false, error: string }> {
	const response = await fetchWithTimeout(url, undefined, BLOCK_EXPLORER_FETCH_TIMEOUT_MS)
	if (!response.ok) return { success: false, error: `Ethercan returned error: ${ response.status }.` }
	return { success: true, result: await response.json() }
}

export function isValidAbi(abi: string) {
	return isValidAbiString(abi)
}

function getBlockExplorer(chainId: ChainIdWithUniversal, rpcEntries: RpcEntries) {
	if (chainId === 'AllChains') return undefined
	const primaryRpc = rpcEntries.find((rpc) => rpc.chainId === chainId && rpc.primary)
	if (primaryRpc !== undefined && primaryRpc.blockExplorer !== undefined) return primaryRpc.blockExplorer
	return getDefaultBlockExplorer()
}

export const isBlockExplorerAvailableForChain = (chainId: ChainIdWithUniversal, rpcEntries: RpcEntries) => getBlockExplorer(chainId, rpcEntries) !== undefined

const parseAbiArray = (abi: string): readonly unknown[] | undefined => {
	try {
		const parsed: unknown = JSON.parse(abi)
		if (!Array.isArray(parsed)) return undefined
		return parsed
	} catch {
		return undefined
	}
}

export const mergeProxyAndImplementationAbi = (proxyAbi: string, implementationAbi: string) => {
	const isProxyAbiValid = isValidAbi(proxyAbi)
	const isImplementationAbiValid = isValidAbi(implementationAbi)
	if (!isProxyAbiValid) return implementationAbi
	if (!isImplementationAbiValid) return proxyAbi
	const proxyAbiEntries = parseAbiArray(proxyAbi)
	const implementationAbiEntries = parseAbiArray(implementationAbi)
	if (proxyAbiEntries === undefined) return implementationAbi
	if (implementationAbiEntries === undefined) return proxyAbi
	const mergedAbi = JSON.stringify([...proxyAbiEntries, ...implementationAbiEntries])
	return isValidAbi(mergedAbi) ? mergedAbi : implementationAbi
}

async function fetchAbi(contractAddress: EthereumAddress, maybeExplorer: BlockExplorer | undefined, chainId: bigint): Promise<Result<EtherscanSourceCodeResult>> {
	const normalizedAddressString = addressString(contractAddress)
	let bestResult: Result<EtherscanSourceCodeResult> = { success: false, message: 'Failed to fetch Abi' } as const
	try {
		if (maybeExplorer !== undefined) {
			try {
				const result = await fetchWithTimeout(`${ maybeExplorer.apiUrl }?chainId=${ chainId.toString() }&module=contract&action=getsourcecode&address=${ normalizedAddressString }&apiKey=${ maybeExplorer.apiKey }`, undefined, BLOCK_EXPLORER_FETCH_TIMEOUT_MS)
				bestResult = EtherscanSourceCodeResult.safeParse(await result.json())
				if (bestResult.success) return bestResult
			} catch(error: unknown) {
				await reportLocalRecovery(error, {
					code: 'etherscan_source_fetch_failed',
					category: 'external_service',
					message: 'Falling back to Sourcify.',
					details: { address: normalizedAddressString, apiUrl: maybeExplorer.apiUrl },
				})
			}
		}
		const result = await fetchWithTimeout(`https://repo.sourcify.dev/contracts/full_match/${ chainId.toString(10) }/${ normalizedAddressString }/metadata.json`, undefined, BLOCK_EXPLORER_FETCH_TIMEOUT_MS)
		if (result.status === 404) return { success: false, message: 'No source available' } as const
		const parsed = SourcifyMetadataResult.safeParse(await result.json())
		if (parsed.success) {
			return { success: true, value: { status: 'success', result: [{
				ContractName: normalizedAddressString,
				ABI: JSON.stringify(parsed.value.output.abi),
				Proxy: 'no' as const, //sourcify does not identify this
				Implementation: ''
			}] } } as const
		}
	} catch(error: unknown) {
		await reportLocalRecovery(error, {
			code: 'sourcify_source_fetch_failed',
			category: 'external_service',
			message: 'Returning the best ABI lookup failure collected so far.',
			details: { address: normalizedAddressString },
		})
	}
	return bestResult
}

export async function fetchAbiFromBlockExplorer(contractAddress: EthereumAddress, chainId: ChainIdWithUniversal) {
	const api = getBlockExplorer(chainId, await getRpcList())

	const parsedSourceCode = await fetchAbi(contractAddress, api, chainId === 'AllChains' ? 1n : chainId)

	// Extract ABI from getSourceCode request if not proxy, otherwise attempt to fetch ABI of implementation
	if (parsedSourceCode.success === false || parsedSourceCode.value.status !== 'success') return { success: false as const, error: 'Could not get ABI for the contract.' }

	if (api !== undefined && parsedSourceCode.value.result[0].Proxy === 'yes' && parsedSourceCode.value.result[0].Implementation !== '') {
		const implReq = await fetchJson(`${ api.apiUrl }?chainId=${ chainId.toString() }&module=contract&action=getabi&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ api.apiKey }`)
		if (!implReq.success) return implReq
		const implResult = EtherscanGetABIResult.safeParse(implReq.result)

		const sourceCodeResult = await fetchJson(`${ api.apiUrl }?chainId=${ chainId.toString() }&module=contract&action=getsourcecode&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ api.apiKey }`)
		if (!sourceCodeResult.success) return sourceCodeResult
		const implementationName = EtherscanSourceCodeResult.safeParse(sourceCodeResult.result)

		if (!implResult.success || !implementationName.success) return { success: false as const, error: 'Failed to parse Etherscan results.' }
		const proxyAndImplementationAbi = mergeProxyAndImplementationAbi(parsedSourceCode.value.result[0].ABI, implResult.value.result)
		if (!isValidAbi(proxyAndImplementationAbi)) return { success: false as const, error: 'Etherscan returned an invalid ABI' }
		return { success: true as const, address: contractAddress, abi: proxyAndImplementationAbi, contractName: `Proxy: ${ implementationName.value.result[0].ContractName }` }
	}
	const abi = parsedSourceCode.value.result[0].ABI
	if (abi && abi !== 'Contract source code not verified') {
		if (!isValidAbi(abi)) return { success: false as const, error: 'Etherscan returned an invalid ABI' }
		return {
			success: true as const,
			abi: parsedSourceCode.value.result[0].ABI,
			contractName: parsedSourceCode.value.result[0].ContractName,
			address: contractAddress,
		}
	}
	return { success: false as const, error: `Etherscan has No ABI available for ${ checksummedAddress(contractAddress) }.` }
}
