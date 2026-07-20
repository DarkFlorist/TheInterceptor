export const normalizeSignatureYParity = (signature: { readonly yParity?: number, readonly v?: bigint | number }) => {
	if (signature.yParity !== undefined) {
		if (signature.yParity !== 0 && signature.yParity !== 1) throw new Error(`Invalid signature yParity ${ signature.yParity }`)
		return signature.yParity
	}
	if (signature.v === undefined) return 0
	const v = BigInt(signature.v)
	if (v === 0n || v === 1n) return Number(v)
	if (v === 27n || v === 28n) return Number(v - 27n)
	throw new Error(`Invalid signature v ${ v }`)
}
