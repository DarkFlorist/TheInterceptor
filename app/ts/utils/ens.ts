import { ens_normalize } from './ethereumPrimitives.js'

export const normalizeEnsNameOrUndefined = (name: string) => {
	try {
		return ens_normalize(name)
	} catch {
		return undefined
	}
}

export const isValidEnsName = (name: string) => normalizeEnsNameOrUndefined(name) !== undefined
