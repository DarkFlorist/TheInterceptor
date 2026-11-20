import type { EthereumAddress } from '../../types/wire-types.js'
import type { IdentifyAddress } from '../../types/metadataLookups.js'
import type { ProtectorChainReads } from '../protectorTypes.js'

export async function getCodeOrError(chainReads: ProtectorChainReads, identify: IdentifyAddress, address: EthereumAddress) {
	const code = await chainReads.readCode(address)
	if (code !== 'unverified') return { statusCode: 'success' as const, hasCode: code === 'present' }
	const identifiedAddress = await identify(address)
	return { statusCode: 'failure' as const, message: `Failed to verify whether address ${ identifiedAddress.address }(${ identifiedAddress.name }) contains code or not.` }
}
