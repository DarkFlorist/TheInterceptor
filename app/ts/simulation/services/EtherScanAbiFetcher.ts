import { ethers } from 'ethers'
import { EtherscanGetABIResult, EtherscanSourceCodeResult } from '../../types/etherscan.js'
import { EthereumAddress } from '../../types/wire-types.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'

const EtherScanABIKey = 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8'

async function fetchJsonOrUndefined(url: string): Promise<{ result: string } | { error: string }> {
	const response = await fetch(url)
	if (!response.ok) return { error: `Ethercan returned error: ${ response.status }.` }
	return { result: await response.json() }
}

export function isValidAbi(abi: string) {
	try {
		new ethers.Interface(abi)
		return true
	} catch(e) {
		return false
	}
}

export async function fetchAbi(contractAddress: EthereumAddress) {
	const json = await fetchJsonOrUndefined(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(contractAddress) }&apiKey=${ EtherScanABIKey }`)
	if ('error' in json) return json
	const parsedSourceCode = EtherscanSourceCodeResult.safeParse(json.result)

	// Extract ABI from getSourceCode request if not proxy, otherwise attempt to fetch ABI of implementation
	if (parsedSourceCode.success == false || parsedSourceCode.value.status !== 'success') return { error: 'Failed to parse Etherscan results.'}
	
	if (parsedSourceCode.value.result[0].Proxy === 'yes' && parsedSourceCode.value.result[0].Implementation !== '') {
		const implReq = await fetchJsonOrUndefined(`https://api.etherscan.io/api?module=contract&action=getabi&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)
		if ('error' in implReq) return implReq
		const implResult = EtherscanGetABIResult.safeParse(implReq.result)
		
		const sourceCodeResult = await fetchJsonOrUndefined(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)
		if ('error' in sourceCodeResult) return sourceCodeResult
		const implementationName = EtherscanSourceCodeResult.safeParse(sourceCodeResult.result)
		
		if (!implResult.success || !implementationName.success) return { error: `Failed to parse Etherscan results.` }
		if (!isValidAbi(implResult.value.result)) return { error: `Etherscan returned an invalid ABI` }
		return { address: contractAddress, abi: implResult.value.result, contractName: `Proxy: ${ implementationName.value.result[0].ContractName }` }
	}
	const abi = parsedSourceCode.value.result[0].ABI
	if (abi && abi !== 'Contract source code not verified') {
		if (!isValidAbi(abi)) return { error: `Etherscan returned an invalid ABI` }
		return {
			abi: parsedSourceCode.value.result[0].ABI,
			contractName: parsedSourceCode.value.result[0].ContractName,
			address: contractAddress,
		}
	}
	return { error: `Etherscan has No ABI available for ${ checksummedAddress(contractAddress) }.` }
}
