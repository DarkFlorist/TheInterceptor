import { normalize } from 'viem/ens'

export const normalizeEnsNameOrUndefined = (name: string) => {
	try {
		return normalize(name)
	} catch {
		return undefined
	}
}

export const isValidEnsName = (name: string) => normalizeEnsNameOrUndefined(name) !== undefined
