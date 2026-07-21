import { reportLocalRecoveryBestEffort } from '../utils/errors.js'

type AddressMetadataWithOptionalAbi = {
	abi?: string
}

export async function getSimulationErrorAbis(errorData: string, getAddressMetadata: () => Promise<AddressMetadataWithOptionalAbi>): Promise<readonly string[]> {
	if (errorData === '0x') return []
	try {
		const identified = await getAddressMetadata()
		return identified.abi === undefined ? [] : [identified.abi]
	} catch (error: unknown) {
		reportLocalRecoveryBestEffort(error, {
			code: 'simulation_error_abi_lookup_failed',
			message: 'Showing the original simulation error without contract ABI decoding.',
		})
		return []
	}
}
