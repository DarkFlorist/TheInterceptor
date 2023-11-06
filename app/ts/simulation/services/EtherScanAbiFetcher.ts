import { ethers } from 'ethers'
import { EtherscanGetABIResult, EtherscanSourceCodeResult } from '../../types/etherscan.js'
import { EthereumAddress } from '../../types/wire-types.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'

const EtherScanABIKey = 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8'

async function fetchJson(url: string): Promise<{ success: true, result: string } | { success: false, error: string }> {
	const response = await fetch(url)
	if (!response.ok) return { success: false, error: `Ethercan returned error: ${ response.status }.` }
	return { success: true, result: await response.json() }
}

export function isValidAbi(abi: string) {
	try {
		new ethers.Interface(abi)
		return true
	} catch(e) {
		return false
	}
}

export async function fetchAbiFromEtherScan(contractAddress: EthereumAddress) {
	const json = await fetchJson(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(contractAddress) }&apiKey=${ EtherScanABIKey }`)
	if (!json.success) return json
	const parsedSourceCode = EtherscanSourceCodeResult.safeParse(json.result)

	// Extract ABI from getSourceCode request if not proxy, otherwise attempt to fetch ABI of implementation
	if (parsedSourceCode.success == false || parsedSourceCode.value.status !== 'success') return { success: false as const, error: 'Failed to parse Etherscan results.'}
	
	if (parsedSourceCode.value.result[0].Proxy === 'yes' && parsedSourceCode.value.result[0].Implementation !== '') {
		const implReq = await fetchJson(`https://api.etherscan.io/api?module=contract&action=getabi&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)
		if (!implReq.success) return implReq
		const implResult = EtherscanGetABIResult.safeParse(implReq.result)
		
		const sourceCodeResult = await fetchJson(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)
		if (!sourceCodeResult.success) return sourceCodeResult
		const implementationName = EtherscanSourceCodeResult.safeParse(sourceCodeResult.result)
		
		if (!implResult.success || !implementationName.success) return { success: false as const, error: `Failed to parse Etherscan results.` }
		if (!isValidAbi(implResult.value.result)) return { success: false as const, error: `Etherscan returned an invalid ABI` }
		return { success: true as const, address: contractAddress, abi: implResult.value.result, contractName: `Proxy: ${ implementationName.value.result[0].ContractName }` }
	}
	const abi = parsedSourceCode.value.result[0].ABI
	if (abi && abi !== 'Contract source code not verified') {
		if (!isValidAbi(abi)) return { success: false as const, error: `Etherscan returned an invalid ABI` }
		return {
			success: true as const,
			abi: parsedSourceCode.value.result[0].ABI,
			contractName: parsedSourceCode.value.result[0].ContractName,
			address: contractAddress,
		}
	}
	return { success: false as const, error: `Etherscan has No ABI available for ${ checksummedAddress(contractAddress) }.` }
}
