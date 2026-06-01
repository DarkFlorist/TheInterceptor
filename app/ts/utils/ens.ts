import { ens_normalize } from './viem.js'

export const normalizeEnsNameOrUndefined = (name: string) => {
	try {
		return ens_normalize(name)
	} catch (error) {
		if (error instanceof Error) return undefined
		return undefined
	}
}

export const isValidEnsName = (name: string) => normalizeEnsNameOrUndefined(name) !== undefined
