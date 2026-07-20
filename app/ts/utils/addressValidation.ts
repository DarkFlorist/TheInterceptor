import { getAddress } from './ethereumPrimitives.js'

export function getIssueWithAddressString(address: string): string | undefined {
	if (address.length > 42) return 'Address is too long.'
	if (address.length > 2 && address.substring(0, 2) !== '0x') return 'Address does not contain 0x prefix.'
	if (address.length < 42) return 'Address is too short.'

	if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
		const checkSummedAddress = getAddress(address.toLowerCase())

		// It is a checksummed address with a bad checksum
		if (checkSummedAddress !== address && address.toLowerCase() !== address) {
			return `Bad address checksum, did you mean ${ checkSummedAddress } ?`
		}
	} else {
		return 'Address contains invalid characters.'
	}

	return undefined
}
