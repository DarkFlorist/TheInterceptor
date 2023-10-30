import { EtherscanGetABIResult, EtherscanSourceCodeResult } from '../../types/etherscan.js'
import { EthereumAddress } from '../../types/wire-types.js'
import { addressString } from '../../utils/bigint.js'

const EtherScanABIKey = 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8'

export async function fetchAbi(contractAddress: EthereumAddress) {
	const parsedSourceCode = EtherscanSourceCodeResult.safeParse(await (await fetch(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(contractAddress) }&apiKey=${ EtherScanABIKey }`)).json())

	// Extract ABI from getSourceCode request if not proxy, otherwise attempt to fetch ABI of implementation
	if (parsedSourceCode.success == false || parsedSourceCode.value.status !== 'success') return undefined
	
	if (parsedSourceCode.value.result[0].Proxy === 'yes' && parsedSourceCode.value.result[0].Implementation !== '') {
		const implReq = await fetch(`https://api.etherscan.io/api?module=contract&action=getabi&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)
		const implResult = EtherscanGetABIResult.safeParse(await implReq.json())
		const implementationName = EtherscanSourceCodeResult.safeParse(await (await fetch(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${ addressString(parsedSourceCode.value.result[0].Implementation) }&apiKey=${ EtherScanABIKey }`)).json())
		if (!implResult.success || !implementationName.success) return undefined
		return { address: contractAddress, abi: implResult.value.result, contractName: `Proxy: ${ implementationName.value.result[0].ContractName }` }
	} else {
		return {
			abi: parsedSourceCode.value.result[0].ABI && parsedSourceCode.value.result[0].ABI !== 'Contract source code not verified' ? parsedSourceCode.value.result[0].ABI : undefined,
			contractName: parsedSourceCode.value.result[0].ContractName,
			address: contractAddress,
		}
	}
}
