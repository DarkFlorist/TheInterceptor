import { EtherscanGetABIResult, EtherscanSourceCodeResult, SourcifyMetadataResult } from '../../types/etherscan.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'
import { getDefaultBlockExplorer } from '../../background/settings.js'
import type { ChainIdWithUniversal } from '../../types/addressBookTypes.js'
import type { BlockExplorer, RpcEntries } from '../../types/rpc.js'
import { getRpcList } from '../../background/storageVariables.js'
import type { Result } from 'funtypes'
import { isValidAbiString } from '../../utils/abiRuntime.js'

async function fetchJson(url: string): Promise<{ success: true, result: unknown } | { success: false, error: string }> {
	const response = await fetch(url)
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

type ContractApiAction = 'getabi' | 'getsourcecode'

export function getBlockExplorerContractUrl(blockExplorer: BlockExplorer, action: ContractApiAction, contractAddress: EthereumAddress, chainId: bigint) {
	const url = new URL(blockExplorer.apiUrl)
	url.searchParams.set('chainId', chainId.toString())
	url.searchParams.set('module', 'contract')
	url.searchParams.set('action', action)
	url.searchParams.set('address', addressString(contractAddress))
	const apiKey = blockExplorer.apiKey.trim()
	if (apiKey.length > 0) url.searchParams.set('apiKey', apiKey)
	return url.toString()
}

async function fetchAbi(contractAddress: EthereumAddress, maybeExplorer: BlockExplorer | undefined, chainId: bigint): Promise<Result<EtherscanSourceCodeResult>> {
	const normalizedAddressString = addressString(contractAddress)
	let bestResult: Result<EtherscanSourceCodeResult> = { success: false, message: 'Failed to fetch Abi' } as const
	try {
		if (maybeExplorer !== undefined) {
			try {
				const result = await fetch(getBlockExplorerContractUrl(maybeExplorer, 'getsourcecode', contractAddress, chainId))
				bestResult = EtherscanSourceCodeResult.safeParse(await result.json())
				if (bestResult.success) return bestResult
			} catch(error: unknown) {
				console.error(`Failed to retrieve ABI for ${ normalizedAddressString } from ${ maybeExplorer.apiUrl }`)
				console.error(error)
			}
		}
		const result = await fetch(`https://repo.sourcify.dev/contracts/full_match/${ chainId.toString(10) }/${ normalizedAddressString }/metadata.json`)
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
		console.error(error)
	}
	return bestResult
}

export async function fetchAbiFromBlockExplorer(contractAddress: EthereumAddress, chainId: ChainIdWithUniversal) {
	const api = getBlockExplorer(chainId, await getRpcList())
	const resolvedChainId = chainId === 'AllChains' ? 1n : chainId

	const parsedSourceCode = await fetchAbi(contractAddress, api, resolvedChainId)

	// Extract ABI from getSourceCode request if not proxy, otherwise attempt to fetch ABI of implementation
	if (parsedSourceCode.success === false || parsedSourceCode.value.status !== 'success') return { success: false as const, error: 'Could not get ABI for the contract.' }

	if (api !== undefined && parsedSourceCode.value.result[0].Proxy === 'yes' && parsedSourceCode.value.result[0].Implementation !== '') {
		const implReq = await fetchJson(getBlockExplorerContractUrl(api, 'getabi', parsedSourceCode.value.result[0].Implementation, resolvedChainId))
		if (!implReq.success) return implReq
		const implResult = EtherscanGetABIResult.safeParse(implReq.result)

		const sourceCodeResult = await fetchJson(getBlockExplorerContractUrl(api, 'getsourcecode', parsedSourceCode.value.result[0].Implementation, resolvedChainId))
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
