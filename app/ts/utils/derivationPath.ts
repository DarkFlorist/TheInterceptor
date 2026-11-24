export type DerivationPathComponent = Readonly<{ index: number, hardened: boolean }>

/** Canonical absolute BIP-32 account paths; no ranges, wildcards or ambiguous leading zeros. */
export function parseDerivationPath(path: string): readonly DerivationPathComponent[] | undefined {
	if (path.length > 128 || !/^m(?:\/(?:0|[1-9][0-9]*)'?){1,10}$/u.test(path)) return undefined
	const components = path.slice(2).split('/').map((component) => ({ index: Number(component.endsWith('\'') ? component.slice(0, -1) : component), hardened: component.endsWith('\'') }))
	return components.every(({ index }) => Number.isSafeInteger(index) && index >= 0 && index < 0x80000000) ? components : undefined
}

export function isEthereumAccountPath(path: string): boolean {
	const components = parseDerivationPath(path)
	return components?.length === 5 && components[0]?.index === 44 && components[0].hardened && components[1]?.index === 60 && components[1].hardened && components[2]?.hardened === true && components[3]?.index === 0 && !components[3].hardened && components[4]?.hardened === false
}
