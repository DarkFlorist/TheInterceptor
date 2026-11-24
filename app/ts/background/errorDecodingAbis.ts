import { needsAbiToDecodeError } from '../utils/errorDecoding.js'
import { isFailedToFetchError, reportLocalRecoveryBestEffort } from '../utils/errors.js'

type AddressMetadataWithOptionalAbi = {
	abi?: string
}

// Takes every error that will be decoded with the same contract's ABI so the contract is looked up at most once, and only when one of them is a custom error selector.
export async function getErrorDecodingAbis(errorDataToDecode: readonly (string | undefined)[], getAddressMetadata: () => Promise<AddressMetadataWithOptionalAbi>): Promise<readonly string[]> {
	if (!errorDataToDecode.some((errorData) => needsAbiToDecodeError(errorData))) return []
	try {
		const identified = await getAddressMetadata()
		return identified.abi === undefined ? [] : [identified.abi]
	} catch (error: unknown) {
		// Transport failures leave the ABI unavailable; cancellation and defects must reach the caller.
		if (!isFailedToFetchError(error)) throw error
		reportLocalRecoveryBestEffort(error, {
			code: 'error_decoding_abi_lookup_failed',
			message: 'Showing the original error without contract ABI decoding.',
		})
		return []
	}
}
