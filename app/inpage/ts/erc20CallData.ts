// Both vendor adapters use the same normalized ABI address words.
const addressWord = (address: string): string => {
	if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid ERC20 call address.')
	return address.slice(2).toLowerCase().padStart(64, '0')
}
export const balanceOfData = (owner: string): string => `0x70a08231${ addressWord(owner) }`
export const allowanceData = (owner: string, spender: string): string => `0xdd62ed3e${ addressWord(owner) }${ addressWord(spender) }`
